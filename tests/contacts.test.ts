import { expect, test } from "bun:test";
import { Gmail } from "../src/gmail.js";
import type { Fetch } from "../src/http.js";
import { digest } from "../src/verification.js";
import { address, addresses } from "../src/sender.js";
import { message } from "./helpers.js";

function client(handler: (url: URL, init: RequestInit) => Response) {
  return new Gmail({ clientId: "id", clientSecret: "secret", refreshToken: "refresh" }, undefined,
    ((url: URL | RequestInfo, init: RequestInit) => Promise.resolve(String(url).includes("oauth2.googleapis.com")
      ? Response.json({ access_token: "access", expires_in: 3600 }) : handler(new URL(String(url)), init))) as Fetch);
}

test("People lookup paginates exact email matches and createContact skips existing contacts", async () => {
  let created = 0, pages = 0;
  const gmail = client((url, init) => {
    if (url.pathname.endsWith("people:createContact")) {
      created++; expect(JSON.parse(String(init.body))).toEqual({ emailAddresses: [{ value: "new@example.com" }] });
      return Response.json({ resourceName: "people/new" });
    }
    expect(url.hostname).toBe("people.googleapis.com");
    expect(url.searchParams.get("personFields")).toBe("emailAddresses");
    pages++;
    return Response.json(url.searchParams.has("pageToken")
      ? { connections: [{ emailAddresses: [{ value: "SHOP@example.com" }] }] }
      : { connections: [{ emailAddresses: [{ value: "shop@example.com.attacker.test" }] }], nextPageToken: "next" });
  });
  expect(await gmail.hasContact("shop@example.com")).toBe(true);
  await gmail.addContact("shop@example.com"); expect(created).toBe(0);
  await gmail.addContact("new@example.com"); expect(created).toBe(1); expect(pages).toBe(6);
});

test.each(["from", "sent", "cc", "bcc"])("correspondence searches retained mail and accepts exact %s matches", async kind => {
  const current = message("b1");
  const gmail = client(url => {
    if (url.pathname.endsWith("/messages")) {
      expect(url.searchParams.get("q")).toContain('in:anywhere {from:"shop@example.com"');
      expect(url.searchParams.get("includeSpamTrash")).toBe("true");
      return Response.json({ messages: [{ id: "a0" }, { id: "b1" }] });
    }
    expect(url.searchParams.get("format")).toBe("metadata");
    return Response.json({ id: "a0", internalDate: kind === "from" ? "1699999999999" : "1700000001000",
      labelIds: kind === "from" ? [] : ["SENT"], payload: { headers: [
        { name: kind === "from" ? "From" : kind === "sent" ? "To" : kind, value: "Shop <shop@example.com>" },
      ] } });
  });
  expect(await gmail.hasCorresponded("shop@example.com", current)).toBe(true);
});

test("current/later/substring/display-name matches never count as earlier correspondence", async () => {
  const gmail = client(url => {
    if (url.pathname.endsWith("/messages")) return Response.json({ messages: ["b1", "c1", "a0"].map(id => ({ id })) });
    const id = url.pathname.split("/").at(-1)!;
    return Response.json({ id, internalDate: id === "c1" ? "1700000000001" : "1699999999999",
      labelIds: ["SENT"], payload: { headers: [
        { name: "From", value: id === "c1" ? "shop@example.com" : "shop@example.com.attacker.test" },
        { name: "To", value: '"shop@example.com" <attacker@example.com>' },
      ] } });
  });
  expect(await gmail.hasCorresponded("shop@example.com", message("b1"))).toBe(false);
});

test("notice has loop protection, fixed Message-ID and safe reply headers; send replay searches Sent", async () => {
  let sent = false;
  const key = digest("notice");
  const gmail = client((url, init) => {
    if (url.pathname.endsWith("/messages")) {
      expect(url.searchParams.get("q")).toBe(`in:sent rfc822msgid:${key}@clefmail.invalid`);
      return Response.json(sent ? { messages: [{ id: "sent1" }] } : {});
    }
    expect(url.pathname.endsWith("/messages/send")).toBe(true);
    expect(sent).toBe(false);
    const raw = Buffer.from(JSON.parse(String(init.body)).raw, "base64url").toString();
    expect(raw).toContain("Auto-Submitted: auto-replied\r\n");
    expect(raw).toContain("In-Reply-To: <original@example.com>");
    expect(raw).toContain(`Message-ID: <${key}@clefmail.invalid>`);
    sent = true; return Response.json({ id: "sent1" });
  });
  await gmail.sendNotice("shop@example.com", "Verify", "Link", key, "<original@example.com>");
  await gmail.sendNotice("shop@example.com", "Verify", "Link", key);
  await expect(gmail.sendNotice("shop@example.com\r\nBcc: victim@example.com", "Verify", "Link", key)).rejects.toThrow("invalid_notice");
  await expect(gmail.sendNotice("shop@example.com", "Verify\r\nBcc: victim@example.com", "Link", key)).rejects.toThrow("invalid_notice");
});

test("releasing held mail removes the held label and optionally restores INBOX", async () => {
  let inbox = true;
  const gmail = client((url, init) => {
    expect(url.pathname).toEndWith("/messages/a1/modify");
    expect(JSON.parse(String(init.body))).toEqual({ addLabelIds: inbox ? ["INBOX"] : [], removeLabelIds: ["Label_held"] });
    return Response.json({ id: "a1" });
  });
  await gmail.releaseHeld("a1", "Label_held", true);
  inbox = false;
  await gmail.releaseHeld("a1", "Label_held", false);
  await expect(gmail.releaseHeld("a1", "STARRED", true)).rejects.toThrow("unsafe_label_mutation");
  await expect(gmail.modify("a1", ["INBOX"], [])).rejects.toThrow("unsafe_label_mutation");
});

test("quoted display-name delimiters never become recipient mailboxes", async () => {
  const to = '"Display, shop@example.com; Name" <other@example.net>, Real <real@example.com>';
  expect(addresses(to)).toEqual(["other@example.net", "real@example.com"]);
  expect(address('"Last, First; \\"Nickname\\"" <Person@example.com>')).toBe("person@example.com");
  expect(address("first@example.net, Last <last@example.com>")).toBeNull();
  expect(address('First <first@example.net>, Last <last@example.com>')).toBeNull();
  for (const invalid of ['"unclosed <a@example.com>', 'Name <a@example.com>,', 'Group: a@example.com;',
    'Name <a@example.com> <b@example.com>', 'a..b@example.com', 'Name <a@example..com>'])
    expect(addresses(invalid)).toBeNull();
  const gmail = client(url => {
    if (url.pathname.endsWith("/messages")) return Response.json({ messages: [{ id: "a0" }] });
    return Response.json({ id: "a0", internalDate: "1699999999999", labelIds: ["SENT"],
      payload: { headers: [{ name: "To", value: to }] } });
  });
  expect(await gmail.hasCorresponded("shop@example.com", message("b1"))).toBe(false);
  expect(await gmail.hasCorresponded("real@example.com", message("b1"))).toBe(true);
});


test("plus-tagged replies require a referenced sent message to the exact base recipient", async () => {
  for (const recipient of ["dpo@coinbase.com", "other@coinbase.com", "dpo@other.com"]) {
    const current = message("b1");
    current.payload!.headers!.push({ name: "In-Reply-To", value: "<original@example.com>" });
    const gmail = client(url => {
      if (url.pathname.endsWith("/messages")) return Response.json({ messages:
        url.searchParams.get("q")!.startsWith("in:sent rfc822msgid:") ? [{ id: "a0" }] : [] });
      return Response.json({ id: "a0", labelIds: ["SENT"], payload: { headers: [
        { name: "Message-ID", value: "<original@example.com>" }, { name: "To", value: recipient },
      ] } });
    });
    expect(await gmail.hasCorresponded("dpo+noreply@coinbase.com", current)).toBe(recipient === "dpo@coinbase.com");
  }
});

test("a plus alias without a reply reference cannot inherit trust from its base address", async () => {
  const gmail = client(url => {
    expect(url.searchParams.get("q")).not.toContain("rfc822msgid:");
    return Response.json({ messages: [] });
  });
  expect(await gmail.hasCorresponded("dpo+noreply@coinbase.com", message())).toBe(false);
});


test("company-domain correspondence requires an exact recipient in human-sent mail", async () => {
  for(const [to,auto,want] of [["colleague@company.example","",true],["person@company.example.attacker.test","",false],["person@company.example","auto-replied",false]] as const){
    const gmail=client(url=>url.pathname.endsWith("/messages")?Response.json({messages:[{id:"a0"}]}):Response.json({id:"a0",labelIds:["SENT"],payload:{headers:[{name:"To",value:to},{name:"Auto-Submitted",value:auto}]}}));
    expect(await gmail.hasDomainCorresponded("company.example")).toBe(want);
  }
});

test("shared providers never confer domain familiarity", async()=>{
  const gmail=client(()=>{throw new Error("No lookup allowed");});
  for(const domain of ["gmail.com","yahoo.co.uk","hotmail.fr","outlook.com","icloud.com","proton.me","fastmail.com","mail.ru","qq.com","privaterelay.appleid.com"])
    expect(await gmail.hasDomainCorresponded(domain)).toBe(false);
});
