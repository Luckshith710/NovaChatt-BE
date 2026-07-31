require("dotenv").config();

let express = require("express");
let cors = require("cors");
let http = require("http");
let crypto = require("crypto");
let bcrypt = require("bcryptjs");
let https = require("https");
let { Server } = require("socket.io");
let { ObjectId } = require("mongodb");
let { sendEmail, sendPasswordResetEmail, sendWelcomeEmail } = require("./services/emailService");

let { messageCollec, photoCollec, userCollec, resetTokenCollec } = require("./config/db");
let { upload, cloudinary } = require("./config/cloudinary");

// ── Firebase Admin SDK setup ──
// Initializes Firebase Admin once using the service account credentials stored
// in FIREBASE_SERVICE_ACCOUNT_JSON (a JSON string in .env).
// Required to update passwords in Firebase Authentication from the backend.
let _firebaseAuth = null;
function getFirebaseAuth() {
  if (_firebaseAuth) return _firebaseAuth;

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON is not set in Backend/.env. " +
      "Generate a service account key from Firebase Console → Project Settings → Service Accounts → Generate new private key, " +
      "then paste the entire JSON as a single line into FIREBASE_SERVICE_ACCOUNT_JSON in Backend/.env."
    );
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch (e) {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON. Make sure the entire key is on one line with no line breaks.");
  }

  const { initializeApp, getApps, cert } = require("firebase-admin/app");
  const { getAuth } = require("firebase-admin/auth");

  if (getApps().length === 0) {
    initializeApp({ credential: cert(serviceAccount) });
    console.log("[Firebase Admin] Initialized with service account:", serviceAccount.client_email);
  }

  _firebaseAuth = getAuth();
  return _firebaseAuth;
}

// Updates a user's password in Firebase Authentication.
// Uses Firebase Admin SDK — requires FIREBASE_SERVICE_ACCOUNT_JSON in .env.
async function updateFirebasePassword(email, newPassword) {
  const firebaseAuth = getFirebaseAuth(); // throws if not configured

  console.log(`[Firebase Admin] Looking up user by email: ${email}`);
  const userRecord = await firebaseAuth.getUserByEmail(email);
  console.log(`[Firebase Admin] User found — UID: ${userRecord.uid}`);

  await firebaseAuth.updateUser(userRecord.uid, { password: newPassword });
  console.log(`[Firebase Admin] ✅ Password updated in Firebase Auth for UID: ${userRecord.uid}`);

  return { uid: userRecord.uid };
}

let app = express();
app.use(express.json());

// ── CORS Configuration ──
let rawClientUrls = process.env.CLIENT_URL || "";
let customOrigins = rawClientUrls.split(",").map((o) => o.trim()).filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin) return true; // Allow non-browser requests
  return (
    customOrigins.includes("*") ||
    customOrigins.includes(origin) ||
    /^https?:\/\/localhost(:\d+)?$/.test(origin) ||
    /^https?:\/\/127\.0\.0\.1(:\d+)?$/.test(origin) ||
    /\.netlify\.app$/.test(origin) ||
    /\.onrender\.com$/.test(origin)
  );
}

let corsOptions = {
  origin: function (origin, callback) {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      console.warn(`[CORS Info] Dynamically permitting origin "${origin}" for API connectivity`);
      callback(null, true);
    }
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

// ── Health Check Endpoint ──
app.get("/", (req, res) => {
  res.json({
    status: "online",
    message: "NovaChat Backend is live & operational! 🚀",
    timestamp: new Date().toISOString()
  });
});

// ── Users Endpoints ──

app.post("/users", async (req, res) => {
  try {
    let { uid, email, displayName, photoURL } = req.body;
    if (!email) {
      return res.status(400).json({ error: "Email is required" });
    }
    let filter = { email };
    let update = {
      $setOnInsert: { createdAt: new Date() },
      $set: {
        uid: uid || null,
        email,
        displayName: displayName || email.split("@")[0],
        photoURL: photoURL || null,
        lastLogin: new Date()
      }
    };
    let existingUser = await userCollec.findOne(filter);
    let options = { upsert: true, returnDocument: 'after' };
    let result = await userCollec.findOneAndUpdate(filter, update, options);

    if (!existingUser) {
      // Send welcome email asynchronously for new users
      sendWelcomeEmail(email, displayName).catch((e) =>
        console.error("[Users Endpoint] Welcome email error:", e)
      );
    }

    res.json({ success: true, user: result });
  } catch (err) {
    console.error("Error saving user:", err);
    res.status(500).json({ error: err.message || "Failed to save user" });
  }
});

app.get("/users/:email", async (req, res) => {
  try {
    let email = req.params.email;
    let user = await userCollec.findOne({ email });
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }
    res.json({ success: true, user });
  } catch (err) {
    console.error("Error fetching user profile:", err);
    res.status(500).json({ error: err.message || "Failed to fetch user" });
  }
});

function handleUpload(field) {
  return (req, res, next) => {
    upload.single(field)(req, res, (err) => {
      if (err) {
        console.error(`[Upload Error] Failed uploading file for field "${field}":`, err);
        return res.status(400).json({
          error: err.message || "File upload failed. Please verify image format and size (max 5MB)."
        });
      }
      next();
    });
  };
}

app.post("/users/profile-picture", handleUpload("file"), async (req, res) => {
  try {
    let email = req.body.email;
    if (!email) {
      return res.status(400).json({ error: "User email is required" });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No image file provided" });
    }

    let allowedMimetypes = ["image/jpeg", "image/png", "image/webp", "image/jpg"];
    if (!allowedMimetypes.includes(req.file.mimetype)) {
      return res.status(400).json({ error: "Invalid file format. Only JPG, JPEG, PNG, and WebP are allowed." });
    }

    if (req.file.size > 5 * 1024 * 1024) {
      return res.status(400).json({ error: "File size exceeds 5MB limit." });
    }

    let photoURL = req.file.path;

    let filter = { email };
    let update = {
      $set: {
        photoURL,
        updatedAt: new Date()
      }
    };
    let options = { returnDocument: 'after' };
    let result = await userCollec.findOneAndUpdate(filter, update, options);

    res.json({
      success: true,
      message: "Profile picture updated successfully",
      photoURL,
      user: result
    });
  } catch (err) {
    console.error("[Profile Picture Error]:", err);
    res.status(500).json({ error: err.message || "Failed to update profile picture" });
  }
});

app.post("/api/forgot-password", async (req, res) => {
  try {
    let { email } = req.body;
    console.log("[Forgot Password Workflow] ── Stage 1: Received email ──", { rawInput: email });

    if (!email || typeof email !== "string" || !email.includes("@")) {
      console.warn("[Forgot Password Workflow] Stage 1 FAIL: Invalid email format provided.", { email });
      return res.status(400).json({ error: "A valid email address is required." });
    }

    let cleanEmail = email.toLowerCase().trim();
    console.log(`[Forgot Password Workflow] ── Stage 2: User lookup in MongoDB for: "${cleanEmail}" ──`);

    // Validate that the user account exists in MongoDB before generating reset link
    let existingUser = await userCollec.findOne({ email: cleanEmail });
    if (!existingUser) {
      console.warn(`[Forgot Password Workflow] Stage 2 FAIL: No account found in database for "${cleanEmail}"`);
      return res.status(404).json({ error: "No account found with this email address." });
    }
    console.log(`[Forgot Password Workflow] ── Stage 2 SUCCESS: Account found (UserID: ${existingUser._id}) ──`);

    // Generate secure single-use token (32 bytes hex)
    console.log("[Forgot Password Workflow] ── Stage 3: Token generation ──");
    let rawToken = crypto.randomBytes(32).toString("hex");
    let hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");
    let expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes expiration
    console.log(`[Forgot Password Workflow] ── Stage 3 SUCCESS: Token generated. Expiration: ${expiresAt.toISOString()} ──`);

    // Store hashed token in MongoDB user document
    console.log("[Forgot Password Workflow] ── Stage 4: MongoDB update ──");
    let updateResult = await userCollec.updateOne(
      { _id: existingUser._id },
      {
        $set: {
          resetPasswordToken: hashedToken,
          resetPasswordExpires: expiresAt,
          updatedAt: new Date()
        }
      }
    );
    console.log(`[Forgot Password Workflow] ── Stage 4 SUCCESS: MongoDB updated (Matched: ${updateResult.matchedCount}, Modified: ${updateResult.modifiedCount}) ──`);

    let clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
    let resetLink = `${clientUrl}/change?token=${rawToken}`;
    console.log(`[Forgot Password Workflow] Reset URL generated: ${resetLink}`);

    // Send the password reset email to the user-entered email address
    console.log(`[Forgot Password Workflow] ── Stage 5: Recipient email & Dispatch attempt for "${cleanEmail}" ──`);
    let emailResult = await sendPasswordResetEmail(cleanEmail, resetLink);
    console.log(`[Forgot Password Workflow] ── Stage 5 DONE: emailResult.success = ${emailResult.success} ──`);

    if (!emailResult.success) {
      console.error(`[Forgot Password Workflow] Stage 5 FAIL: Email delivery failed for "${cleanEmail}". Reason:`, emailResult.error);
      console.log("[Forgot Password Workflow] ── Stage 6: Final API response (500 Error) ──");
      return res.status(500).json({
        error: "Unable to send the password reset email. Please try again later."
      });
    }

    console.log(`[Forgot Password Workflow] ── Stage 6: Final API response (200 Success) — Email Message-ID: ${emailResult.id} ──`);
    return res.json({
      success: true,
      message: "A password reset link has been sent to your email.",
      recipient: cleanEmail,
      emailId: emailResult.id
    });
  } catch (err) {
    console.error("[Forgot Password Workflow] ── UNHANDLED ERROR in handler:", {
      message: err.message,
      stack: err.stack
    });
    console.log("[Forgot Password Workflow] ── Stage 6: Final API response (500 Error) ──");
    return res.status(500).json({
      error: "Unable to send the password reset email. Please try again later."
    });
  }
});

app.get("/api/verify-reset-token", async (req, res) => {
  try {
    let { token } = req.query;
    if (!token || typeof token !== "string") {
      return res.status(400).json({ valid: false, error: "Token is required" });
    }

    let hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    let user = await userCollec.findOne({ resetPasswordToken: hashedToken });
    if (!user) {
      return res.status(400).json({ valid: false, error: "Invalid password reset token." });
    }

    if (!user.resetPasswordExpires || new Date(user.resetPasswordExpires) < new Date()) {
      return res.status(400).json({ valid: false, error: "This password reset token has expired." });
    }

    res.json({ valid: true, email: user.email });
  } catch (err) {
    console.error("Verify token error:", err);
    res.status(500).json({ valid: false, error: err.message || "Failed to verify token" });
  }
});

app.post("/api/reset-password", async (req, res) => {
  try {
    let { token, newPassword } = req.body;

    // ── Validate inputs ──
    if (!token || !newPassword) {
      return res.status(400).json({ error: "Token and new password are required" });
    }
    if (typeof newPassword !== "string" || newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters long" });
    }

    // ── Step 1: Validate MongoDB reset token ──
    console.log("[Reset Password] Step 1: Validating reset token...");
    let hashedToken = crypto.createHash("sha256").update(token).digest("hex");
    let user = await userCollec.findOne({ resetPasswordToken: hashedToken });
    if (!user) {
      console.warn("[Reset Password] Step 1 FAIL: Token not found in database.");
      return res.status(400).json({ error: "Invalid or already used password reset token." });
    }
    if (!user.resetPasswordExpires || new Date(user.resetPasswordExpires) < new Date()) {
      console.warn(`[Reset Password] Step 1 FAIL: Token expired for ${user.email}.`);
      return res.status(400).json({ error: "This password reset token has expired. Please request a new link." });
    }
    console.log(`[Reset Password] Step 1 OK: Valid token for ${user.email} (expires ${user.resetPasswordExpires.toISOString()})`);

    // ── Step 2: Update password in Firebase Authentication ──
    // Login uses Firebase Auth (signInWithEmailAndPassword), so the password
    // MUST be updated in Firebase Auth — not just in MongoDB — for the new
    // password to work at the sign-in screen.
    console.log(`[Reset Password] Step 2: Updating password in Firebase Auth for ${user.email}...`);
    try {
      await updateFirebasePassword(user.email, newPassword);
      console.log(`[Reset Password] Step 2 OK: Firebase Auth password updated for ${user.email}`);
    } catch (firebaseErr) {
      console.error("[Reset Password] Step 2 FAIL: Firebase Auth update error:", {
        message: firebaseErr.message,
        email: user.email
      });
      return res.status(500).json({
        error: "Failed to update password. Please try again or request a new reset link."
      });
    }

    // ── Step 3: Invalidate the single-use token in MongoDB ──
    console.log(`[Reset Password] Step 3: Invalidating reset token in MongoDB...`);
    await userCollec.updateOne(
      { _id: user._id },
      {
        $set: { passwordUpdatedAt: new Date() },
        $unset: {
          resetPasswordToken: "",
          resetPasswordExpires: ""
        }
      }
    );
    console.log(`[Reset Password] Step 3 OK: Token invalidated for ${user.email}.`);

    console.log(`[Reset Password] ✅ Complete: password reset successful for ${user.email}`);
    return res.json({
      success: true,
      message: "Password updated successfully! You can now sign in with your new password."
    });
  } catch (err) {
    console.error("[Reset Password] UNHANDLED ERROR:", { message: err.message, stack: err.stack });
    return res.status(500).json({ error: "An unexpected error occurred. Please try again." });
  }
});

// ── Snaps / Media Endpoints ──

app.post("/upload", handleUpload("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file provided" });
  }
  let obj = {
    username: req.body.username,
    caption: req.body.caption,
    file_url: req.file.path,
    file_name: req.file.filename
  };

  photoCollec.insertOne(obj)
    .then((result) => res.json(result))
    .catch((err) => {
      console.error("Upload error:", err);
      res.status(500).json({ error: err.message || "Failed to upload file" });
    });
});

app.get("/files", (req, res) => {
  photoCollec.find().toArray()
    .then((result) => res.json(Array.isArray(result) ? result : []))
    .catch((err) => {
      console.error("Get files error:", err);
      res.status(500).json({ error: err.message || "Failed to fetch files" });
    });
});

app.delete("/delete/:id", (req, res) => {
  let id = req.params.id;
  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ error: "Invalid file ID" });
  }
  let _id = new ObjectId(id);

  photoCollec.findOne({ _id })
    .then((obj) => {
      if (!obj) {
        throw new Error("File not found");
      }
      return cloudinary.uploader.destroy(obj.file_name)
        .then(() => photoCollec.deleteOne({ _id }));
    })
    .then((result) => res.json(result))
    .catch((err) => {
      console.error("Delete error:", err);
      res.status(500).json({ error: err.message || "Failed to delete file" });
    });
});

// ── Global Error Handling Middleware ──
app.use((err, req, res, next) => {
  console.error("[Unhandled Express Error]:", err);
  res.status(err.status || 500).json({
    error: err.message || "An unexpected internal server error occurred."
  });
});

// ── HTTP + Socket.IO Server ──

let httpServer = http.createServer(app);
let io = new Server(httpServer, {
  cors: {
    origin: function (origin, callback) {
      if (isAllowedOrigin(origin)) {
        callback(null, true);
      } else {
        console.warn(`[Socket.IO CORS] Permitting origin "${origin}"`);
        callback(null, true);
      }
    },
    methods: ["GET", "POST"],
    credentials: true,
  }
});

// Map to track connected sockets: socket.id -> username
let connectedUsersMap = new Map();

io.on("connection", (socket) => {
  console.log(`🔌 [Socket.IO] New client connected. Socket ID: ${socket.id}`);

  // User join/mapping event
  socket.on("join", (data) => {
    let username = typeof data === "string" ? data : data?.username;
    if (username) {
      connectedUsersMap.set(socket.id, username);
      socket.join("global");
      console.log(`👤 [Socket.IO] User mapped: ${username} -> Socket ID: ${socket.id} (Room: global)`);
    }
  });

  // Fetch chat history
  socket.on("getHistory", async () => {
    try {
      let history = await messageCollec.find().sort({ createdAt: 1 }).toArray();
      console.log(`📜 [Backend] Fetched ${history.length} historical messages for Socket ID: ${socket.id}`);
      socket.emit("history", history);
    } catch (err) {
      console.error("❌ [Backend] getHistory error:", err);
      socket.emit("history_error", { error: "Failed to fetch chat history" });
    }
  });

  // Send message event handler
  socket.on("message", async (data, callback) => {
    console.log(`📥 [Backend request received] Message received from socket ${socket.id}:`, data);
    try {
      if (!data || !data.message || typeof data.message !== "string" || !data.message.trim()) {
        throw new Error("Message content cannot be empty.");
      }
      if (!data.username) {
        throw new Error("Sender username is required.");
      }

      let messageDoc = {
        username: data.username,
        message: data.message.trim(),
        photoURL: data.photoURL || null,
        createdAt: new Date()
      };

      // 1. Save message to MongoDB
      let result = await messageCollec.insertOne(messageDoc);
      console.log(`💾 [MongoDB save] Message saved successfully with _id: ${result.insertedId}`);

      let responsePayload = {
        ...messageDoc,
        _id: result.insertedId
      };

      // 2. Broadcast via Socket.IO to all connected clients immediately
      io.emit("message", responsePayload);
      console.log(`📡 [Socket event emitted] Broadcasted 'message' event to all clients:`, responsePayload);

      // 3. Return success acknowledgment to sender
      if (typeof callback === "function") {
        callback({ success: true, message: responsePayload });
      }
    } catch (err) {
      console.error(`❌ [Backend Error] Message handling failed:`, err);
      if (typeof callback === "function") {
        callback({ success: false, error: err.message || "Failed to process message." });
      }
    }
  });

  socket.on("disconnect", (reason) => {
    let mappedUser = connectedUsersMap.get(socket.id);
    connectedUsersMap.delete(socket.id);
    console.log(`❌ [Socket.IO] Client disconnected. Socket ID: ${socket.id} (${mappedUser || "Unknown user"}). Reason: ${reason}`);
  });
});

// Render sets PORT automatically; fall back to 3000 for local dev
let PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`NovaChat backend running on port ${PORT}`));