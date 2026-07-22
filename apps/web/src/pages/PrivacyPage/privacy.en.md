# Privacy Policy

TypeTrip (the "Service") takes user privacy seriously and publishes this policy to meet the
transparency requirements of Korea's Personal Information Protection Act (PIPA) and the EU
General Data Protection Regulation (GDPR). The Service **never collects account sign-up
information, email, phone number, real name, or date of birth.** Each section below describes
only what is actually collected and processed.

## 1. Overview and Data Controller

- Service name: TypeTrip
- Operator: {PLACEHOLDER: legal entity / operator name}
- Contact: {PLACEHOLDER: privacy@ email address}
- Effective date: 2026-07-22 (v1.0)

## 2. What We Collect and How

**We do not collect accounts, email, real names, dates of birth, or phone numbers.** The Service
is designed to be playable instantly in a browser with no login. Only the following three
categories are actually processed:

- A one-way derived value of a device identifier (deviceId) — the raw deviceId is never stored
  on the server; only a signed session token remains, kept in the browser's localStorage.
- A nickname — freely chosen by the player and shown on leaderboards. Since it may contain a
  real name, we treat it as personal data.
- Gameplay records — countries completed, score, accuracy, grade, elapsed time, and similar
  statistics.
- A country-level region code captured at signup (`CF-IPCountry`) — **the raw IP address itself
  is never stored.**
- (Only with consent) a GA4 analytics identifier — it is not even loaded unless the consent
  banner is accepted.

## 3. Purposes of Processing

- Providing the Service and maintaining record continuity (contract performance)
- Computing and displaying leaderboards
- Preventing abuse (detecting anomalous records, handling reports)
- (With consent) usage analytics to improve the Service

## 4. Retention Periods

| Item | Retention |
|---|---|
| deviceId-derived value / session token | 2 years after last activity |
| Nickname | Same as account (anonymized immediately on deletion) |
| Gameplay records (ranked entries) | Kept indefinitely as leaderboard data |
| Input-rhythm detail of a run (detail_json) | Automatically cleared after 90 days |
| Report / sanction records | 1 year after the sanction ends |
| GA4 identifier (with consent) | Per GA4 settings (2 months) |

## 5. Processing Outsourcing and Cross-Border Transfer

The Service entrusts storage and processing of the data above to Cloudflare, Inc. (United
States), using its global network (D1/KV/Durable Objects). The transferred items are all of the
categories listed in Section 2, and the retention period matches Section 4. A Data Processing
Agreement (DPA) and Standard Contractual Clauses (SCC) are in place with Cloudflare. (With
consent) Google LLC's GA4 is used separately for analytics.

## 6. Cookies and Similar Technologies

The Service **does not use cookies.** Identity is established solely through a signed token
stored in the browser's `localStorage`, which is never shared with other sites. GA4 is only
loaded after the consent banner is accepted, and consent can be withdrawn at any time from
Settings.

## 7. Your Rights and How to Exercise Them

All of the following are available as instant self-service, with no login required.

- **Access / portability**: Settings → "Download my data" → downloads everything held about you
  as a JSON file immediately (no manual processing wait).
- **Deletion ("right to be forgotten")**: Settings → "Reset and delete my data" (two-step
  confirmation) → your nickname is anonymized, leaderboard entries are removed, and the device
  mapping is released, all immediately. The leaderboard cache, however, is only refreshed on its
  next cycle, so it may take **up to 10 minutes** to fully disappear from view.
- **Rectification**: the nickname-change feature serves as the means of correction.
- Other inquiries: contact {PLACEHOLDER: privacy@ email address} and we will respond after
  review.

## 8. Children's Personal Information

The Service never asks for age (age itself is additional personal data). Because no real name or
contact information is ever collected, there is no processing activity that would require
parental consent. That said, community features (such as multiplayer lobby chat) are
recommended for users aged 14 and older.

## 9. Security Measures

- Encryption in transit (HTTPS/TLS)
- Signed session-token verification and request rate limiting
- Pseudonymization (one-way hash derivation of deviceId, hashed analytics events)
- Access controls on stored data

## 10. Data Protection Officer and Contact

- Name / title: {PLACEHOLDER}
- Email: {PLACEHOLDER}

## 11. Notification Obligations

Changes to this policy are announced in-service at least 7 days before they take effect. Changes
materially affecting user rights are announced 30 days in advance.

## Addendum

- Effective date: 2026-07-22

| Version | Effective date | Change |
|---|---|---|
| v1.0 | 2026-07-22 | Initial version |
