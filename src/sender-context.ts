// Shared mailbox providers must never establish trust for unrelated users.
const SHARED = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "ymail.com", "rocketmail.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "aim.com", "proton.me", "protonmail.com", "pm.me", "tutanota.com", "tutanota.de", "tuta.com", "tuta.io", "tutamail.com", "keemail.me",
  "fastmail.com", "fastmail.fm", "hey.com", "mail.com", "email.com", "usa.com", "gmx.com", "gmx.de", "gmx.net", "web.de", "posteo.de", "mailbox.org",
  "yandex.com", "yandex.ru", "ya.ru", "mail.ru", "inbox.ru", "list.ru", "bk.ru", "qq.com", "foxmail.com", "163.com", "126.com", "yeah.net", "naver.com", "daum.net", "hanmail.net",
  "zoho.com", "zohomail.com", "rediffmail.com", "mailfence.com", "hushmail.com", "runbox.com", "disroot.org", "riseup.net", "duck.com", "simplelogin.com", "simplelogin.io", "anonaddy.com", "addy.io", "mozmail.com", "privaterelay.appleid.com",
  "btinternet.com", "btopenworld.com", "sky.com", "virginmedia.com", "ntlworld.com", "blueyonder.co.uk", "talktalk.net", "tiscali.co.uk", "plus.net", "comcast.net", "verizon.net", "att.net", "sbcglobal.net", "bellsouth.net", "cox.net", "charter.net", "earthlink.net", "orange.fr", "wanadoo.fr", "free.fr", "laposte.net", "libero.it", "alice.it",
  "mailinator.com", "yopmail.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "getnada.com",
]);
export function customSenderDomain(domain: string): boolean {
  const value = domain.toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,63}$/.test(value) && !SHARED.has(value) &&
    !/(^|\.)(gmail|googlemail|outlook|hotmail|live|msn|yahoo|aol|gmx|yandex)\.[a-z.]+$/.test(value);
}
export interface SenderContext {
  ownAddress: boolean;
  contact: boolean;
  previousCorrespondence: boolean;
  verified: boolean;
  pendingVerification: boolean;
  sentToSameCustomDomain: boolean;
  bimiDmarc: boolean;
  verificationTest: boolean;
}
