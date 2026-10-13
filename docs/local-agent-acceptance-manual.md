# Local Agent Execution Manual and Acceptance Criteria

This manual is for a local agent running on the developer machine after the Lingxi companion backend and mobile integration fixes are pushed.

## Scope

Validate the local BYOC backend, Flutter mobile client, LAN connection, device registration, device token authorization, SSE chat, context reporting, and proactive care flow.

## Prerequisites

- Node.js 18 or newer.
- npm available in PATH.
- Flutter SDK available in PATH.
- Dart SDK available in PATH through Flutter.
- Android device or emulator available through adb.
- The phone and backend host are on the same LAN for LAN validation.

## Environment Check

Run from the repository root:

```bash
node -v
npm -v
flutter --version
dart --version
adb devices
```

Acceptance criteria:

- Node.js version is 18 or newer.
- Flutter and Dart commands are available.
- `adb devices` shows at least one online device or emulator for mobile validation.

## Backend Validation

Run from `backend/`:

```bash
npm install
npm run check
```

Acceptance criteria:

- `npm run typecheck` passes.
- `npm run build` passes.

Start the backend for local LAN testing:

```bash
LINGXI_HOST=0.0.0.0 LINGXI_PORT=11438 npm run dev
```

In a second terminal, run:

```bash
curl http://127.0.0.1:11438/api/health
curl http://127.0.0.1:11438/api/v1/connect-info
curl http://127.0.0.1:11438/api/v1/pair
```

Acceptance criteria:

- `/api/health` returns `status: ok`.
- `/api/v1/connect-info` returns `baseUrl`, `localIps`, and `port`.
- `/api/v1/pair` returns `pair_code`, `baseUrl`, `localIps`, `port`, and `expires_at`.

## Device Token API Validation

Run from any terminal with the backend still running:

```bash
node --input-type=module <<'JS'
const base = 'http://127.0.0.1:11438';
const reg = await fetch(`${base}/api/v1/devices/register`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ device_id: 'local-agent-device', device_type: 'phone', capabilities: ['display'] })
});
const regJson = await reg.json();
if (!reg.ok || !regJson.device_token) throw new Error('device registration failed');

const noAuth = await fetch(`${base}/api/v1/proactive-care?device_id=local-agent-device`);
if (noAuth.status !== 401) throw new Error(`expected unauthorized proactive-care status 401, got ${noAuth.status}`);

const context = await fetch(`${base}/api/v1/context`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Lingxi-Device-Token': regJson.device_token
  },
  body: JSON.stringify({
    device_id: 'local-agent-device',
    timestamp: Date.now(),
    activity_state: 'working',
    inferred_mood: 'neutral',
    location_context: 'unknown',
    battery_level: null
  })
});
if (!context.ok) throw new Error(`context report failed with ${context.status}`);

const care = await fetch(`${base}/api/v1/proactive-care?device_id=local-agent-device`, {
  headers: { 'X-Lingxi-Device-Token': regJson.device_token }
});
if (![200, 204].includes(care.status)) throw new Error(`authorized proactive-care failed with ${care.status}`);

const largeBody = JSON.stringify({ message: 'x'.repeat(1100000) });
const tooLarge = await fetch(`${base}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: largeBody
});
if (tooLarge.status !== 413) throw new Error(`expected request size status 413, got ${tooLarge.status}`);

console.log(JSON.stringify({
  register: reg.status,
  unauthorizedCare: noAuth.status,
  context: context.status,
  authorizedCare: care.status,
  tooLarge: tooLarge.status
}));
JS
```

Acceptance criteria:

- Device registration returns HTTP 200 and a device token.
- Proactive care without token returns HTTP 401.
- Context report with token returns HTTP 200.
- Proactive care with token returns HTTP 200 or 204.
- Oversized `/api/chat` body returns HTTP 413.
- Do not print or store the actual device token outside this validation process.

## Mobile Static Validation

Run from `mobile/`:

```bash
flutter pub get
flutter analyze
flutter test
```

Acceptance criteria:

- Dependencies resolve successfully.
- `flutter analyze` reports no blocking errors.
- `flutter test` passes.

## Mobile Integration Validation

Run from `mobile/` with backend still running:

```bash
flutter run
```

Manual validation steps:

1. Open the app on the device or emulator.
2. Open the connection screen.
3. Scan the backend QR code or manually enter `http://<backend-lan-ip>:11438`.
4. Confirm connection status changes to `LAN`.
5. Send a chat message.
6. Confirm the app receives the SSE buffer message and final reply.
7. Leave the app open for at least one context reporting interval.
8. Confirm backend logs show `/api/v1/context` ingestion.
9. Trigger or seed proactive care, then confirm the card appears in the app.
10. Close the proactive care card and confirm it disappears.
11. Change the backend address or reconnect, then confirm SSE reconnects and chat still works.

Acceptance criteria:

- QR/manual connection updates the shared backend base URL.
- SSE reconnects after base URL changes.
- Device registration succeeds after connection changes.
- Context reports include the registered device ID and pass token authorization.
- Proactive care polling uses the real device ID and token.
- The proactive care card can be dismissed.

## Optional Memory Regression

Run from `backend/` when local runtime resources are available:

```bash
npm run eval:user-model
npm run eval:v7-memory
npm run eval:stability
npm run eval:retrieval
```

Acceptance criteria:

- Each command completes successfully.
- Eval scripts print their expected PASS output or documented benchmark result.
- Real embedding validation should be run only when the local embedding endpoint is configured.

## Failure Triage Order

Use this order when a validation step fails:

1. Backend process and port: confirm `LINGXI_HOST=0.0.0.0` and `LINGXI_PORT=11438`.
2. LAN reachability: open `http://<backend-lan-ip>:11438/api/health` from the phone browser.
3. Device token: re-register the device and retry token-protected endpoints.
4. Shared mobile base URL: reconnect from QR/manual input and retry chat.
5. SSE stream: inspect `/api/events` connection logs and reconnect the app.
6. Context reporting: verify mobile permissions and backend `/api/v1/context` response.
7. Proactive care: confirm proactive fragments have `is_proactive = 1` and `is_read = 0` before polling.
8. Flutter issues: run `flutter clean`, then `flutter pub get`, then `flutter analyze`.
