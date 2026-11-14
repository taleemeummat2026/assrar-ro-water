# Ashhar RO Water — Backend API

Node.js (Express) + MySQL API for:

- the **Customer app** and **Delivery app** (`../App`) — endpoints in [../App/API.md](../App/API.md)
- the **Super Admin web app** (to be built) — `/v1/admin/...` endpoints listed below
- the **website** — new connection enquiry form and company details (`/v1/public/...`)

Requires Node.js 20+ and MySQL 8 or MariaDB 10.6+.

## 1. Set up

```bash
cd Backend
npm install
cp .env.example .env        # then fill in the values (see below)
npm run db:migrate          # creates all tables, the company row and the first Owner login
npm start                   # API on http://localhost:4000  (health check: /health)
```

### What goes in `.env`

| Setting | What to put |
|---|---|
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | Your MySQL database details (Hostinger → Databases) |
| `JWT_SECRET` | Long random text — `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
| `ADMIN_MOBILE`, `ADMIN_PASSWORD`, `ADMIN_NAME` | First Owner login for the admin panel (remove the password after the first `db:migrate`) |
| `PUBLIC_URL` | Address of this API, e.g. `https://api.ashharrowater.com` (used for photo links) |
| `CORS_ORIGINS` | Admin panel and website addresses |
| `SMS_PROVIDER`, `SMS_URL_TEMPLATE` | Your SMS company for OTPs and reminders (see `.env.example`) |
| `TEST_OTP` | `1234` while testing: every customer logs in with 1234 and no SMS is sent. **Remove before launch.** |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Razorpay keys for online payment (see section 4b). Empty = online payment hidden |
| `PUSH_ENABLED`, `EXPO_ACCESS_TOKEN` | Push notifications (on by default; the access token only if Expo “enhanced security” is on) |
| `OTP_TEST_NUMBERS` | e.g. `9876500001:1234` — a fixed OTP for the Google Play reviewer only |

Never commit `.env` (it is in `.gitignore`).

### Try it with demo data

On an **empty test database** only:

```bash
npm run db:seed-demo
```

This loads the same sample data the apps show in demo mode:

| Who | Login |
|---|---|
| Admin (Owner) | `9876500000` / `admin123` |
| Delivery boys | `9876511111` or `9876522222` / `1234` |
| Customers | `9876500001` … `9876500030`, OTP `1234` (while `TEST_OTP=1234`) |

### Before launch

```bash
npm run db:clear-demo -- --yes      # removes all demo customers/entries and the demo admin login
```

Then remove `TEST_OTP` from `.env`, set up the SMS company, and restart.

## 2. Connect the apps

In `App/customer-app/eas.json` and `App/delivery-app/eas.json` set
`EXPO_PUBLIC_API_URL` to `https://<your API domain>/v1` and build again. For testing on a phone in the same Wi-Fi:

```bash
EXPO_PUBLIC_API_URL=http://<your-computer-ip>:4000/v1 npm start      # inside an app folder
```

## 3. Deploy on Hostinger

**Hostinger VPS (recommended)**

```bash
# on the server, once
sudo apt install -y nodejs npm nginx && sudo npm i -g pm2
git clone <your repo> && cd RO-water/Backend
npm ci --omit=dev
nano .env                                   # production values, NODE_ENV=production
npm run db:migrate
pm2 start src/server.js --name ashhar-api && pm2 save && pm2 startup
```

Then point a sub-domain (e.g. `api.your-domain.com`) to the VPS, add an Nginx site that proxies to
`http://127.0.0.1:4000`, and turn on SSL with `sudo certbot --nginx`. Set `client_max_body_size 6m;` in
Nginx so delivery photos can upload.

**Hostinger plan with "Node.js app" in hPanel:** upload the `Backend` folder, set the start command to `npm start`,
add the `.env` values in the panel, and run `npm run db:migrate` once from the terminal / SSH.

**Updating later:** `git pull && npm ci --omit=dev && npm run db:migrate && pm2 restart ashhar-api`

## 4. Backups and background jobs

While the server runs it checks every 30 minutes and:

- makes a daily backup `backups/YYYY-MM-DD.sql.gz` (kept 14 days). Restore with phpMyAdmin → Import, or
  `gunzip < backups/2026-11-12.sql.gz | mysql -u USER -p DBNAME`. Copy backups off the server regularly too.
- on the 1st of every month notifies each customer that last month's bill is ready
- clears expired OTPs

Manual backup: `npm run db:backup`. Add a new admin or reset a password: `npm run admin:create -- 9876500000 "NewPass123" "Name" owner`.

## 4b. Razorpay online payment

1. Create a Razorpay account → Settings → **API Keys** → generate keys (use **Test mode** first; test keys start with `rzp_test_`).
2. Put them in `.env`: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and set `PUBLIC_URL` to the API's public https address.
3. Razorpay → Settings → **Webhooks** → add `<PUBLIC_URL>/v1/public/razorpay/webhook`, event **payment_link.paid**, choose a secret
   and put it in `RAZORPAY_WEBHOOK_SECRET`.
4. Restart the API. Customers now see **Pay online** on their bill and on event orders; every payment is checked with Razorpay
   before it is recorded, and shows in the admin panel under Payments → Online payments.

Test payments: UPI `success@razorpay`, or card 4100 2800 0000 1007 with any future expiry / CVV.

## 4c. Push notifications

The apps register for push automatically after login once they are built with EAS (not in Expo Go). One-time setup per app:
`npx eas-cli@latest init` (paste the project id into `app.json` → `expo.extra.eas.projectId` if asked), create a Firebase
project, add `google-services.json` (`android.googleServicesFile`) and upload the FCM V1 service-account key with
`npx eas-cli@latest credentials`. Nothing to configure on the server.

## 5. Super Admin API (`/v1/admin`, Bearer token from `POST /v1/auth/admin/login`)

Roles: **owner** (everything), **manager** (operations), **accounts** (payments, bills, reports, read customers).

| Area | Endpoints |
|---|---|
| Me / dashboard | `GET /me` · `GET /dashboard?date=` — today's deliveries, pending, not taken, collections, dues, per delivery boy, not-updated customers |
| Customers | `GET /customers?q=&routeId=&active=&page=` · `GET /customers/:id` · `POST /customers` (auto `RO-0001` ID) · `PATCH /customers/:id` (edit / `active:false`) · `POST /customers/import` (rows from Excel) · `GET /customers/:id/calendar?month=` · `GET /customers/:id/bills/:month` |
| Routes | `GET /routes` · `POST /routes` · `PATCH /routes/:id` · `PUT /routes/:id/order` · `PUT /routes/:id/cover` (leave cover for a day) · `DELETE /routes/:id/cover/:date` |
| Delivery boys | `GET /delivery-boys` · `POST /delivery-boys` · `PATCH /delivery-boys/:id` (incl. password, active) |
| Daily monitoring | `GET /entries?date=&routeId=&deliveryBoyId=&kind=` (live status, pending/missed) · `PUT /entries` (correct with `reason`, logged) · `DELETE /entries/:customerId/:date` (with `reason`) |
| Requests | `GET /requests?status=&type=` · `POST /requests/:id/decision` `{ decision: approved/rejected/resolved, note }` |
| Payments | `GET /payments?from=&to=&mode=` · `POST /payments` · `POST /reminders/dues` (in-app + SMS + WhatsApp links) |
| Event orders | `GET /event-orders?status=` · `POST /event-orders` (phone order) · `POST /event-orders/:id/assign` `{ deliveryBoyId }` · `POST /event-orders/:id/deliver` · `POST /event-orders/:id/reject` · `PATCH /event-orders/:id` `{ emptiesCollected }` |
| Online payments | `GET /online-payments` — Razorpay links (waiting / paid / expired) |
| Enquiries | `GET /enquiries?status=` · `PATCH /enquiries/:id` — convert by `POST /customers` with `enquiryId` |
| Notifications | `POST /notifications` (offer/info to all, a route, or chosen customers) |
| Jar stock | `GET /jar-stock` · `POST /jar-stock` (purchase / damaged / lost) |
| Reports | `GET /reports/{daily-deliveries, customer-monthly, missed, jar-balance, collections, outstanding, delivery-boy-performance}` — add `?format=csv` for Excel |
| Settings | `GET/PUT /company` (name, GST, prices) · `GET/POST/PATCH /users` (owner) · `GET /activity` (audit log) |

## 6. Tests

```bash
npm test
```

Starts a temporary MySQL 8.4 (downloaded once, ~75 s the first time), loads the demo data and checks the
customer, delivery and admin flows end to end: billing, jar balance, safe retries, photo upload, roles,
reports and backup restore.

## Project layout

```
db/schema.sql        all tables          db/migrate.js     create/update tables
db/seed-demo.js      demo data           db/backup.js      daily SQL backup
src/app.js           routes & security   src/config.js     reads .env
src/lib/billing.js   bill & jar rules (same as the apps)
src/routes/          auth, customer, delivery, public, admin/*
src/services/        data shaping, today's list, dues, live day view
```
