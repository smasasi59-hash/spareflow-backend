require("dotenv").config();
const express = require("express");
const cors = require("cors");
const axios = require("axios");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.enable("trust proxy");
app.use(cors({ origin: true }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper to sanitize URLs (always ensure http:// or https://, strip markdown wrappers, and remove trailing slashes)
function sanitizeUrl(url, defaultUrl) {
  let clean = (url || defaultUrl || "").toString().trim();
  if (!clean) return defaultUrl;
  const mdMatch = clean.match(/\[.*?\]\((https?:\/\/[^\s\)]+)\)/i) || clean.match(/\((https?:\/\/[^\s\)]+)\)/i);
  if (mdMatch) {
    clean = mdMatch[1];
  }
  clean = clean.replace(/[\[\]\(\)]/g, "").trim();
  if (!clean.startsWith("http://") && !clean.startsWith("https://")) {
    clean = "https://" + clean;
  }
  return clean.replace(/\/+$/, "");
}

// Configuration
let rawBaseUrl = process.env.SASI_PAY_BASE_URL || "https://pay.sasidigital.co.tz/v1";
let cleanBaseUrl = sanitizeUrl(rawBaseUrl, "https://pay.sasidigital.co.tz/v1");
if (cleanBaseUrl.endsWith("/payments")) {
  cleanBaseUrl = cleanBaseUrl.substring(0, cleanBaseUrl.length - "/payments".length);
}
const SASI_PAY_BASE_URL = cleanBaseUrl;

const SASI_PAY_SECRET_KEY =
  (process.env.SASI_PAY_SECRET_KEY || "").toString().trim();
const SASI_WEBHOOK_SECRET =
  (process.env.SASI_WEBHOOK_SECRET || "whsec_f0c794d61455746d06782578b4d91aae3e9eb66b3336e7f1").toString().trim();
const FIREBASE_PROJECT_ID =
  (process.env.FIREBASE_PROJECT_ID || "lito-684b2").toString().trim();
const BACKEND_URL = sanitizeUrl(
  process.env.BACKEND_URL || "https://spareflow-backend-production.up.railway.app",
  "https://spareflow-backend-production.up.railway.app"
);

// Initialize Firebase Admin
let db = null;
try {
  let credential = null;

  if (process.env.FIREBASE_SERVICE_ACCOUNT_KEY) {
    try {
      const raw = process.env.FIREBASE_SERVICE_ACCOUNT_KEY.trim();
      const jsonStr = raw.startsWith("{")
        ? raw
        : Buffer.from(raw, "base64").toString("utf8");
      const serviceAccount = JSON.parse(jsonStr);
      credential = admin.credential.cert(serviceAccount);
      console.log("Firebase Admin: Loaded credentials from FIREBASE_SERVICE_ACCOUNT_KEY environment variable.");
    } catch (e) {
      console.error("Firebase Admin: Error parsing FIREBASE_SERVICE_ACCOUNT_KEY:", e.message);
    }
  } else if (
    process.env.GOOGLE_APPLICATION_CREDENTIALS &&
    fs.existsSync(process.env.GOOGLE_APPLICATION_CREDENTIALS)
  ) {
    credential = admin.credential.cert(process.env.GOOGLE_APPLICATION_CREDENTIALS);
    console.log("Firebase Admin: Loaded credentials from GOOGLE_APPLICATION_CREDENTIALS path.");
  } else {
    const localKeyPath = path.join(__dirname, "serviceAccountKey.json");
    if (fs.existsSync(localKeyPath)) {
      credential = admin.credential.cert(localKeyPath);
      console.log("Firebase Admin: Loaded credentials from local serviceAccountKey.json.");
    }
  }

  if (credential) {
    admin.initializeApp({
      credential,
      projectId: FIREBASE_PROJECT_ID,
    });
  } else {
    console.warn(
      "Firebase Admin: No service account provided. Initializing with Project ID only (may have restricted write access without serviceAccountKey)."
    );
    admin.initializeApp({
      projectId: FIREBASE_PROJECT_ID,
    });
  }

  db = admin.firestore();
  console.log(`Firebase Firestore connected successfully for project: ${FIREBASE_PROJECT_ID}`);
} catch (err) {
  console.error("Firebase Admin initialization error:", err.message);
}

// Phone Number formatting helper (Tanzania -> 255XXXXXXXXX)
function formatPhone255(phone) {
  if (!phone) return "";
  let clean = phone.toString().replace(/[^0-9]/g, "");
  if (clean.startsWith("255") && clean.length === 12) {
    return clean;
  }
  if (clean.startsWith("0") && clean.length === 10) {
    return "255" + clean.substring(1);
  }
  if (clean.length === 9) {
    return "255" + clean;
  }
  return clean;
}

// Detect Mobile Network Operator in Tanzania
function detectNetwork(phone) {
  const p = formatPhone255(phone);
  if (p.length === 12 && p.startsWith("255")) {
    const prefix = p.substring(3, 5);
    if (["74", "75", "76"].includes(prefix)) return "VODACOM";
    if (["71", "65", "67", "77"].includes(prefix)) return "TIGO";
    if (["68", "69", "78"].includes(prefix)) return "AIRTEL";
    if (["62", "61"].includes(prefix)) return "HALOTEL";
  }
  return "AIRTEL";
}

// -------------------------------------------------------------
// ROUTES
// -------------------------------------------------------------

// Health check / Keep-alive route (for Render.com free tier)
app.get("/", (req, res) => {
  res.json({
    status: "online",
    service: "SpareFlow Sasi Pay Backend",
    version: "1.0.4",
    formatPhone: "255XXXXXXXXX",
    hasWebhookSecret: Boolean(SASI_WEBHOOK_SECRET),
    sasiBaseUrl: SASI_PAY_BASE_URL,
    backendUrl: BACKEND_URL,
    firebaseProject: FIREBASE_PROJECT_ID,
    hasFirestore: Boolean(db),
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok", uptime: process.uptime() });
});

/**
 * 1. INITIATE SUBSCRIPTION PAYMENT
 * POST /initiateSubscriptionPayment or /api/initiateSubscriptionPayment
 * Body: { planId, amount, durationDays, customerPhone, shopId, shopName, planName, userId }
 */
const handleInitiatePayment = async (req, res) => {
  try {
    const {
      planId,
      amount,
      durationDays,
      customerPhone,
      shopId,
      shopName,
      planName,
      userId,
    } = req.body || {};

    if (!planId || !amount || !customerPhone || !shopId) {
      return res.status(400).json({
        error: "Taarifa hazijakamilika. (planId, amount, customerPhone, na shopId zinahitajika).",
      });
    }

    const formattedPhone = formatPhone255(customerPhone);
    if (
      formattedPhone.length !== 12 ||
      !formattedPhone.startsWith("255")
    ) {
      return res.status(400).json({
        error: "Namba ya simu sio sahihi. Tafadhali tumia 07xxxxxxxx au 06xxxxxxxx (mfano: 0688620614).",
      });
    }

    const network = detectNetwork(formattedPhone);
    const intAmount = parseInt(amount, 10);
    const days = parseInt(durationDays, 10) || 30;
    const reference = `SF-SUB-${Date.now()}-${Math.floor(1000 + Math.random() * 9000)}`;

    const effectiveBackendUrl = sanitizeUrl(
      process.env.BACKEND_URL || `${req.protocol}://${req.get("host")}`,
      BACKEND_URL
    );

    const webhookUrl = process.env.SASI_WEBHOOK_URL
      ? sanitizeUrl(process.env.SASI_WEBHOOK_URL, "")
      : `${effectiveBackendUrl}/sasiPayWebhook`;

    const baseWithoutPayments = cleanBaseUrl.replace(/\/payments\/?$/, "");
    const paymentsEndpoint = `${baseWithoutPayments}/payments/`;

    const payload = {
      amount: intAmount,
      currency: "TZS",
      customer_phone: formattedPhone,
      phone: formattedPhone,
      phone_number: formattedPhone,
      payment_method: "mobile_money",
      network: network,
      provider: network.toLowerCase(),
      channel: network.toLowerCase(),
      customer_name: shopName || "SpareFlow Merchant",
      reference: reference,
      narration: `SpareFlow Subscription - ${planName || planId}`,
      callback_url: webhookUrl,
      metadata: {
        shopId: shopId,
        userId: userId || "",
        planId: planId,
        durationDays: days,
        network: network,
      },
    };

    console.log(`[Sasi Pay Request] POST ${paymentsEndpoint}`);
    console.log(`[Sasi Pay Request] Payload:`, JSON.stringify(payload));

    let sasiResponseData = null;
    try {
      const sasiResponse = await axios.post(
        paymentsEndpoint,
        payload,
        {
          headers: {
            Authorization: `Bearer ${SASI_PAY_SECRET_KEY}`,
            "Content-Type": "application/json",
            "Idempotency-Key": reference,
          },
          timeout: 25000,
          maxRedirects: 0,
        }
      );
      sasiResponseData = sasiResponse.data;
      console.log(`[Sasi Pay Response] Status ${sasiResponse.status}:`, JSON.stringify(sasiResponseData));
    } catch (apiErr) {
      console.error(
        "[Sasi Pay Error] Status:",
        apiErr.response?.status,
        "Data:",
        JSON.stringify(apiErr.response?.data || apiErr.message)
      );
      const errMsg =
        apiErr.response?.data?.message ||
        apiErr.response?.data?.error ||
        apiErr.message;
        apiErr.message;

      // Save failed record in Firestore if db is ready
      if (db) {
        try {
          await db.collection("subscription_payments").doc(reference).set({
            reference: reference,
            shopId: shopId,
            userId: userId || "",
            planId: planId,
            planName: planName || planId,
            amount: intAmount,
            durationDays: days,
            customerPhone: formattedPhone,
            customerName: shopName || "SpareFlow Merchant",
            status: "failed",
            failureReason: errMsg,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        } catch (dbErr) {
          console.error("Firestore write error:", dbErr.message);
        }
      }

      return res.status(502).json({
        error: `Hitilafu ya Sasi Pay: ${errMsg}`,
        reference: reference,
      });
    }

    // Save initial transaction in Firestore
    if (db) {
      try {
        const sasiData = (sasiResponseData && sasiResponseData.data) || {};
        await db.collection("subscription_payments").doc(reference).set({
          reference: reference,
          merchantReference: reference,
          sasiReference: sasiData.reference || "",
          sasiPaymentId: sasiData.id || "",
          shopId: shopId,
          userId: userId || "",
          planId: planId,
          planName: planName || planId,
          amount: intAmount,
          durationDays: days,
          customerPhone: formattedPhone,
          network: network,
          customerName: shopName || "SpareFlow Merchant",
          status: "processing",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          sasiResponse: sasiResponseData,
        });
      } catch (dbErr) {
        console.error("Firestore write processing error:", dbErr.message);
      }
    }

    return res.status(200).json({
      success: true,
      reference: reference,
      status: "processing",
      message:
        "Ujumbe wa malipo (USSD Prompt) umetumwa kwenye simu yako. Tafadhali ingiza PIN kukamilisha.",
      data: sasiResponseData,
    });
  } catch (err) {
    console.error("Unhandled error in initiateSubscriptionPayment:", err);
    return res.status(500).json({
      error: `Hitilafu ya ndani ya seva: ${err.message}`,
    });
  }
};

app.post("/initiateSubscriptionPayment", handleInitiatePayment);
app.post("/api/initiateSubscriptionPayment", handleInitiatePayment);

/**
 * 2. SASI PAY WEBHOOK CALLBACK
 * POST /sasiPayWebhook or /api/sasiPayWebhook
 */
const handleWebhook = async (req, res) => {
  try {
    const payload = req.body || {};
    console.log("Sasi Pay Webhook Callback received:", JSON.stringify(payload));

    const signature =
      req.headers["x-sasi-signature"] ||
      req.headers["x-signature"] ||
      req.headers["sasi-signature"] ||
      req.headers["signature"];

    if (signature && SASI_WEBHOOK_SECRET) {
      try {
        const computed = crypto
          .createHmac("sha256", SASI_WEBHOOK_SECRET)
          .update(JSON.stringify(payload))
          .digest("hex");
        if (computed.toLowerCase() === signature.toLowerCase()) {
          console.log("[Webhook] Sasi Pay signature verified successfully.");
        } else {
          console.warn(
            `[Webhook Notice] Signature check: received=${signature}, computed=${computed}`
          );
        }
      } catch (sigErr) {
        console.warn("[Webhook] Signature verification error:", sigErr.message);
      }
    }

    const data = payload.data || payload;
    const merchantRef = data.merchant_reference || payload.merchant_reference;
    const sasiRef = data.reference || payload.reference;
    const targetRef = merchantRef || sasiRef;
    const rawStatus = (data.status || payload.status || "")
      .toString()
      .toLowerCase();

    if (!targetRef) {
      console.warn("Webhook missing reference:", payload);
      return res.status(400).json({ error: "Missing reference" });
    }

    if (!db) {
      console.error("Firestore DB is not connected. Cannot process webhook.");
      return res.status(500).json({ error: "Database not connected" });
    }

    let paymentDoc = null;
    let targetDocRef = null;

    if (merchantRef) {
      const snap = await db.collection("subscription_payments").doc(merchantRef).get();
      if (snap.exists) {
        paymentDoc = snap;
        targetDocRef = snap.ref;
      }
    }

    if (!paymentDoc && sasiRef) {
      const snap = await db.collection("subscription_payments").doc(sasiRef).get();
      if (snap.exists) {
        paymentDoc = snap;
        targetDocRef = snap.ref;
      }
    }

    if (!paymentDoc) {
      let querySnap = await db
        .collection("subscription_payments")
        .where("reference", "==", targetRef)
        .limit(1)
        .get();

      if (querySnap.empty && sasiRef) {
        querySnap = await db
          .collection("subscription_payments")
          .where("sasiReference", "==", sasiRef)
          .limit(1)
          .get();
      }

      if (!querySnap.empty) {
        paymentDoc = querySnap.docs[0];
        targetDocRef = querySnap.docs[0].ref;
      }
    }

    let paymentData = paymentDoc ? paymentDoc.data() : null;

    // Payment Successful
    if (
      rawStatus === "completed" ||
      rawStatus === "success" ||
      rawStatus === "successful"
    ) {
      console.log(`Malipo ya reference ${reference} yamekamilika! Inawasha kifurushi...`);

      await targetDocRef.set(
        {
          status: "completed",
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          webhookPayload: payload,
        },
        { merge: true }
      );

      const shopId =
        (paymentData && paymentData.shopId) ||
        (data.metadata && data.metadata.shopId);
      const durationDays = parseInt(
        (paymentData && paymentData.durationDays) ||
        (data.metadata && data.metadata.durationDays) ||
        30,
        10
      );
      const planId =
        (paymentData && paymentData.planId) ||
        (data.metadata && data.metadata.planId) ||
        "1_month";

      if (shopId) {
        const shopRef = db.collection("shops").doc(shopId);
        const shopDoc = await shopRef.get();

        let baseDate = new Date();
        if (shopDoc.exists) {
          const shopData = shopDoc.data();
          const currentExpiry = shopData.subscriptionExpiryDate;
          if (currentExpiry && currentExpiry.toDate) {
            const currentExpiryDate = currentExpiry.toDate();
            if (currentExpiryDate > baseDate) {
              baseDate = currentExpiryDate;
            }
          }
        }

        const newExpiryDate = new Date(
          baseDate.getTime() + durationDays * 24 * 60 * 60 * 1000
        );

        await shopRef.set(
          {
            subscriptionStatus: "active",
            subscriptionExpiryDate:
              admin.firestore.Timestamp.fromDate(newExpiryDate),
            subscriptionPlanId: planId,
            lastSubscriptionPaymentRef: reference,
            lastSubscriptionAmount: (paymentData && paymentData.amount) || 0,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          },
          { merge: true }
        );

        console.log(
          `Duka ${shopId} limewezeshwa kifurushi hadi: ${newExpiryDate.toISOString()}`
        );
      }
    } else if (
      rawStatus === "failed" ||
      rawStatus === "expired" ||
      rawStatus === "cancelled"
    ) {
      await targetDocRef.set(
        {
          status: rawStatus,
          failureReason:
            data.message || payload.message || `Malipo ${rawStatus}`,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          webhookPayload: payload,
        },
        { merge: true }
      );
    } else {
      await targetDocRef.set(
        {
          status: rawStatus || "processing",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          webhookPayload: payload,
        },
        { merge: true }
      );
    }

    return res
      .status(200)
      .json({ success: true, reference: reference, status: rawStatus });
  } catch (err) {
    console.error("Webhook processing error:", err);
    return res.status(500).json({ error: err.message });
  }
};

app.post("/sasiPayWebhook", handleWebhook);
app.post("/api/sasiPayWebhook", handleWebhook);

/**
 * 3. STATUS CHECK ENDPOINT
 * GET /checkSubscriptionPaymentStatus?reference=xxx
 */
const handleStatusCheck = async (req, res) => {
  try {
    const reference = req.query.reference || req.body?.reference;
    if (!reference) {
      return res.status(400).json({ error: "Reference is required" });
    }

    if (db) {
      const paymentDoc = await db
        .collection("subscription_payments")
        .doc(reference)
        .get();

      if (paymentDoc.exists) {
        const pData = paymentDoc.data();
        if (pData.status === "completed") {
          return res.status(200).json({ status: "completed", data: pData });
        }
      }
    }

    // Direct check from Sasi Pay API
    if (SASI_PAY_SECRET_KEY) {
      try {
        const baseWithoutPayments = cleanBaseUrl.replace(/\/payments\/?$/, "");
        const sasiQueryRef = (paymentDoc && paymentDoc.exists && paymentDoc.data()?.sasiReference) || reference;
        const checkUrl = `${baseWithoutPayments}/payments/${sasiQueryRef}`;
        
        console.log(`[Sasi Pay Status Check] GET ${checkUrl}`);
        const sasiRes = await axios.get(
          checkUrl,
          {
            headers: { Authorization: `Bearer ${SASI_PAY_SECRET_KEY}` },
            timeout: 10000,
          }
        );

        const data = sasiRes.data?.data || sasiRes.data || {};
        const status = (data.status || "").toLowerCase();

        if (status === "completed" || status === "success") {
          if (db) {
            const paymentDocRef = db.collection("subscription_payments").doc(reference);
            const paymentDoc = await paymentDocRef.get();
            const pData = paymentDoc.exists ? paymentDoc.data() : {};

            await paymentDocRef.set(
              {
                status: "completed",
                completedAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );

            const shopId = pData.shopId || data.metadata?.shopId;
            const durationDays = parseInt(
              pData.durationDays || data.metadata?.durationDays || 30,
              10
            );
            const planId = pData.planId || data.metadata?.planId || "1_month";

            if (shopId) {
              const shopRef = db.collection("shops").doc(shopId);
              const shopDoc = await shopRef.get();
              let baseDate = new Date();
              if (shopDoc.exists) {
                const sData = shopDoc.data();
                if (sData.subscriptionExpiryDate?.toDate) {
                  const curr = sData.subscriptionExpiryDate.toDate();
                  if (curr > baseDate) baseDate = curr;
                }
              }
              const newExpiry = new Date(
                baseDate.getTime() + durationDays * 24 * 60 * 60 * 1000
              );
              await shopRef.set(
                {
                  subscriptionStatus: "active",
                  subscriptionExpiryDate:
                    admin.firestore.Timestamp.fromDate(newExpiry),
                  subscriptionPlanId: planId,
                  lastSubscriptionPaymentRef: reference,
                  updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
              );
            }
          }

          return res.status(200).json({ status: "completed", data: data });
        }

        return res.status(200).json({ status: status || "processing", data: data });
      } catch (apiErr) {
        console.warn("Direct Sasi Pay check error:", apiErr.message);
      }
    }

    return res.status(200).json({ status: "processing", reference: reference });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};

app.get("/checkSubscriptionPaymentStatus", handleStatusCheck);
app.get("/api/checkSubscriptionPaymentStatus", handleStatusCheck);

// Start server
app.listen(PORT, "0.0.0.0", () => {
  console.log(`===============================================`);
  console.log(`SpareFlow Backend running on port: ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Base URL: ${BACKEND_URL}`);
  console.log(`Sasi Pay Secret: ${SASI_PAY_SECRET_KEY ? "CONFIGURED (***" + SASI_PAY_SECRET_KEY.slice(-4) + ")" : "MISSING"}`);
  console.log(`===============================================`);
});
