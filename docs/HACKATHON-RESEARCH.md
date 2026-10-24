# Countersign: event and product strategy

Verified 24 October 2026 (IST) against official public sources. The Devpost connector requested
reauthentication, so public official pages were used. No registration, consent, submission,
promo-code claim, paid service or external message was made.

## Event requirements

The target is [PayPal AI Hackathon: Build what’s next with PayPal and AI](https://paypalaihackathon.devpost.com/).
The deadline is **13 November 2026, 1:30 AM IST**. Judging runs **2 December, 3:30 AM through
15 December, 9:30 PM IST**. The schedule and rules differ slightly on the announcement time;
the rules say approximately 22 December, 3:30 AM IST. Keep the application accessible through
judging. [Schedule](https://paypalaihackathon.devpost.com/details/dates),
[official rules](https://paypalaihackathon.devpost.com/rules).

Meaningful PayPal sandbox integration and AI are required, together with public licensed source,
a usable demonstration or complete run instructions, and a public YouTube video under three minutes.
Existing projects require significant event-period work. Implementation, design, impact, innovation
and presentation carry equal judging weight. Sponsor technology is optional. These are planning
summaries, not a legal acknowledgment; consult the rules themselves before submitting.
[Requirements and judging](https://paypalaihackathon.devpost.com/rules).

India appears eligible subject to age, local law and conflict exclusions. Brazil, Quebec, Russia,
Crimea, Cuba, Iran and North Korea are expressly excluded, with additional sanctions restrictions.
Team eligibility does not establish PayPal merchant feature eligibility.
[Eligibility](https://paypalaihackathon.devpost.com/rules).

Grand prizes are USD 12,000 / 8,000 / 5,000. Five honorable mentions award USD 5,000 each,
including Agentic Commerce and PayPal + AI. Relevant sponsor prizes include Bryntum USD 1,000 ×3
and Render credits of USD 1,000 / 750 / 500. Winning combinations are restricted by the rules.
[Prize listing](https://paypalaihackathon.devpost.com/), [rules](https://paypalaihackathon.devpost.com/rules).

## Sponsor choices without an assumed budget

**Render:** the [event page](https://paypalaihackathon.devpost.com/details/render) offers USD 50 in
credits. That is distinct from ordinary free service and sponsor prize credits. Credit expiry,
existing-account eligibility and payment-method requirements need confirmation before claiming.
Credits are applied to workspace bills; usage beyond credits remains payable.
[Credit terms](https://render.com/docs/credits).

The [ordinary free tier](https://render.com/docs/free) sleeps web services after 15 idle minutes,
shares 750 monthly hours per workspace, expires free Postgres after 30 days, and does not offer
free private services/background workers. It cannot reproduce the proposed always-on three-service
architecture through December without changes or credits. Do not call the deployment free until
compute, storage, bandwidth, expiry and judging duration have been budgeted. Local Docker remains
the working no-hosting-cost development path.

**Bryntum:** the [event offer](https://paypalaihackathon.devpost.com/details/bryntum) is a 45-day trial,
not a perpetual free license. Its suggested dispute-triage board fits this product, but the
[general EULA](https://bryntum.com/legal/Bryntum%20EULA.pdf) restricts trial use to evaluation and
describes a different trial duration. Confirm public deployment, redistribution and December
judging coverage with the sponsor before shipping trial assets. Keep the ordinary table usable
without it. No paid trial or sponsor account was enabled in this work.

No PayPal event participation was found among the connected MLH events. MLH offers must not be
presented as PayPal event benefits; no unrelated promotion was claimed.

## A sharper product and demonstration

The primary audience is **a merchant accepting purchases proposed by shopping agents**. The concrete
problem is reconstructing what the buyer actually authorized when a purchase is challenged.
The product promise is: **signed spending limits before payment, an inspectable authorization
trail afterwards**. Do not promise a guaranteed chargeback win, automatic legal liability, or
globally available unattended charging.

Build the submission story around one merchant, one buyer and three observable outcomes:

1. A signed approval and successful sandbox purchase within its original amount, currency and payee.
2. The same agent attempts to exceed a limit or follow injected listing instructions; the Gate refuses
   before a PayPal order exists, with an inspectable reason.
3. A merchant compares transaction facts with the authorization trail and chooses the appropriate
   evidence response or honest refund. PayPal's actual outcome remains distinct from our recommendation.

The current app demonstrates signing and persistent quotes; it does **not** yet complete this
three-part payment story. The missing tenant/mandate/budget/order integration is the first
engineering priority before additional sponsor features or a larger catalog.

For Bryntum, a useful extension is assigned evidence-preparation work, dispute deadlines and evidence
readiness, with an accessible table fallback. Add it only after the purchase/evidence path is real.
This directly supports the merchant task rather than adding a decorative sponsor widget.

## International applicability

Show original ISO currency codes with every price, preserve quantity and delivery choices, and
refuse silent exchange. Keep payment eligibility separate from fulfillment destinations and display
deadlines with explicit zones. Physical shipping in this sample catalog is currently USD-only;
the app now discloses that limit before checkout.

PayPal India's guidance distinguishes international from domestic receipts. The PayPal
save-without-purchase availability/approval requirements do not establish Indian merchant support
for the proposed vaulting flow. Use an explicitly described supported sandbox merchant configuration
for the demonstration rather than promising Indian unattended charges.
[India receipts](https://www.paypal.com/in/cshelp/article/can-i-use-paypal-to-receive-payments-from-indian-customers-help1049),
[wallet saving](https://developer.paypal.com/api/payment-tokens/save-without-purchase/paypal/).

The user-facing home, navigation, demo guide, quote copy and coverage page now reflect this narrower
promise. Currency codes and fail-closed payment eligibility help the product travel across regions;
adding unverified country flags or exchange rates would not.
