# Privacy Policy

TypeTrip (the "Service") takes user privacy seriously and publishes this policy to meet the
transparency requirements of Korea's Personal Information Protection Act (PIPA) and the EU
General Data Protection Regulation (GDPR). The Service **never collects account sign-up
information, email, phone number, real name, or date of birth.** You can play Single Play and the
Daily Challenge 100% without logging in. Signing in with a Google account is only required to
appear on leaderboards or join real-time multiplayer, and only in that case do we process a
minimal set of account-identifying information. Each section below describes only what is
actually collected and processed.

## 1. Overview and Data Controller

- Service name: TypeTrip
- Operator: 박진우
- Contact: dkdleldjqkr976@gmail.com
- Effective date: 2026-07-24 (v1.0)

## 2. What We Collect and How

**We never collect accounts, email, real names, dates of birth, or phone numbers while
signed out.** The Service is designed to be playable instantly in a browser with no login. While
signed out, only the following are actually processed:

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

**Only if you sign in with a Google account**, the following items are additionally processed
(signing in is optional, and only needed to appear on the leaderboard or join multiplayer).

- Google account identifier (`sub`) — never stored verbatim; converted to a one-way derived
  value before storage.
- Email address — collected only when Google has marked it `email_verified`.
- Profile name — the display name registered on your Google account.

## 3. Purposes of Processing

- Providing the Service and maintaining record continuity (contract performance)
- Computing and displaying leaderboards, and confirming eligibility to join real-time
  multiplayer (signed-in accounts only)
- Preventing abuse (detecting anomalous records, handling reports)
- (With consent) usage analytics to improve the Service

## 4. Retention Periods

| Item | Retention |
|---|---|
| deviceId-derived value / session token | 2 years after last activity |
| Nickname | Same as account (anonymized immediately on deletion) |
| Gameplay records (ranked entries) | Kept indefinitely as leaderboard data |
| Input-rhythm detail of a run (detail_json) | Automatically cleared after 90 days |
| Google account identifier / email / profile name | Deleted immediately on account deletion, otherwise 2 years after last activity |
| Report / sanction records | 1 year after the sanction ends |
| GA4 identifier (with consent) | Per GA4 settings (2 months) |

## 5. Processing Outsourcing and Cross-Border Transfer

The Service entrusts storage and processing of the data above to Cloudflare, Inc. (United
States), using its global network (D1/KV/Durable Objects). The transferred items are all of the
categories listed in Section 2, and the retention period matches Section 4. A Data Processing
Agreement (DPA) and Standard Contractual Clauses (SCC) are in place with Cloudflare.

If you sign in with Google, **Google LLC (United States)** is involved in authentication
(OAuth 2.0 / OpenID Connect). Our server only verifies the signature of the identity token
(ID token) signed by Google — it never receives or stores login credentials such as your
password. (With consent) Google LLC's GA4 is used separately for analytics.

## 6. Cookies and Similar Technologies

The Service **does not use cookies.** Identity is established solely through a signed token
stored in the browser's `localStorage`, which is never shared with other sites. GA4 is only
loaded after the consent banner is accepted, and consent can be withdrawn at any time.

## 7. Your Rights and How to Exercise Them

You may exercise your rights of **access (and portability), rectification, erasure, and
restriction of processing** over your personal data at any time. To exercise a right, send a
request by email to the contact below.

- **How to request**: email dkdleldjqkr976@gmail.com stating which right you wish to exercise
  (access / rectification / erasure / restriction) together with information we can use to
  locate your data (such as the nickname you use in the Service). We may ask for a minimal
  amount of additional information to verify that the request comes from you (or an authorized
  agent).
- **Processing time**: access requests are answered within 10 days; other requests are handled
  without undue delay and no later than 30 days, after which we reply with the result.
- **What erasure ("right to be forgotten") does**: your nickname is anonymized, leaderboard
  entries are removed, and both the device mapping and any Google account identifier mapping
  are released. The leaderboard cache is only refreshed on its next cycle, so it may take up to
  10 minutes to fully disappear from view. Disconnecting or revoking the Service's access to
  your Google account itself is done separately from your Google account settings.
- **Rectification**: you can correct your nickname directly with the in-service nickname-change
  feature; for anything else, use the email above.

## 8. Children's Personal Information

The Service never asks for age (age itself is additional personal data). Because no real name or
contact information is ever collected, there is no processing activity that would require
parental consent. That said, community features (such as multiplayer lobby chat) are
recommended for users aged 14 and older.

## 9. Security Measures

- Encryption in transit (HTTPS/TLS)
- Signed session-token verification and request rate limiting
- Signature verification (JWKS, RS256) of Google login identity tokens
- Pseudonymization (one-way hash derivation of deviceId and Google account identifiers, hashed
  analytics events)
- Access controls on stored data

## 10. Data Protection Officer and Contact

- Name / title: 박진우 (Operator)
- Email: dkdleldjqkr976@gmail.com

## 11. Notification Obligations

Changes to this policy are announced in-service at least 7 days before they take effect. Changes
materially affecting user rights are announced 30 days in advance.

## Addendum

- Effective date: 2026-07-24 (v1.0)
