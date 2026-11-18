# SpareFlow Sasi Pay Backend (Node.js/Express)

Hii ni backend nyepesi ya Node.js/Express iliyotengenezwa mahsusi kuchakata malipo ya Sasi Pay na kusasisha vifurushi moja kwa moja kwenye Firestore ya mradi wa `lito-684b2` **bila kuhitaji Firebase Blaze Plan ($$$)**.

---

## 🚀 Jinsi ya Kuiweka Bure kwenye Render.com (Hatua kwa Hatua)

### Hatua ya 1: Pakia folda hii GitHub
1. Weka folda hii ya `backend` kwenye akaunti yako ya GitHub (kama repo mpya, mfano: `spareflow-backend`).
   ```bash
   git init
   git add .
   git commit -m "Initial commit for SpareFlow Sasi Pay Backend"
   git branch -M main
   git remote add origin https://github.com/USERNAME/spareflow-backend.git
   git push -u origin main
   ```

### Hatua ya 2: Fungua Huduma Bure Render.com
1. Ingia [Render.com](https://render.com) (jisajili bure ukitumia GitHub).
2. Bonyeza **New +** -> **Web Service**.
3. Chagua repo yako ya `spareflow-backend`.
4. Jaza mipangilio ifuatayo:
   - **Name:** `spareflow-backend` (au jina unalopenda)
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Plan Type:** `Free` ($0/mwezi)

### Hatua ya 3: Weka Environment Variables kwenye Render
Chini kwenye sehemu ya **Environment Variables**, weka:
- `SASI_PAY_SECRET_KEY`: `test_04ed2c9368cb9029`
- `SASI_PAY_BASE_URL`: `https://pay.sasidigital.co.tz/v1`
- `FIREBASE_PROJECT_ID`: `lito-684b2`
- `BACKEND_URL`: URL utakayopewa na Render (mfano: `https://spareflow-backend.onrender.com`)
- `FIREBASE_SERVICE_ACCOUNT_KEY`: *(Hiari lakini inashauriwa)* Pakua faili la `serviceAccountKey.json` kutoka Firebase Console -> Project Settings -> Service Accounts -> "Generate new private key", kisha ufungue faili hilo, nakili maudhui yote ya JSON na ubandike hapa.

5. Bonyeza **Create Web Service**. Ndani ya dakika 1-2 mfumo utakuwa hewani!

---

## 🌐 Endpoints Zinazopatikana
- `GET /health` au `GET /` — Kuangalia kama seva ipo hewani (Keep-alive)
- `POST /initiateSubscriptionPayment` — Kuanzisha malipo ya Sasi Pay (USSD Push)
- `POST /sasiPayWebhook` — Callback kutoka Sasi Pay mara mteja anapoweka PIN
- `GET /checkSubscriptionPaymentStatus?reference=SF-SUB-xxx` — Kukagua hali ya malipo
