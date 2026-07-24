require("dotenv").config();

let express = require("express");
let cors = require("cors");
let http = require("http");
let crypto = require("crypto");
let bcrypt = require("bcryptjs");
let { Server } = require("socket.io");
let { ObjectId } = require("mongodb");
let { sendEmail, sendPasswordResetEmail, sendWelcomeEmail } = require("./services/emailService");

let { messageCollec, photoCollec, userCollec, resetTokenCollec } = require("./config/db");
let { upload, cloudinary } = require("./config/cloudinary");

let app = express();
app.use(express.json());

// ── CORS Configuration ──
// Reads allowed origins from CLIENT_URL (supports comma-separated URLs)
// Always allows localhost for development convenience alongside deployed frontend URLs.
let rawClientUrls = process.env.CLIENT_URL || "";
let allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
  "http://localhost:4173",
  ...rawClientUrls.split(",").map((o) => o.trim()).filter(Boolean)
];

let corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (mobile apps, curl, Postman)
    if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`[CORS Warning] Blocked request from origin: "${origin}"`);
      callback(null, false);
    }
  },
  credentials: true,
};

app.use(cors(corsOptions));

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
    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ error: "A valid email address is required." });
    }

    let cleanEmail = email.toLowerCase().trim();
    console.log(`[Forgot Password] Reset request for: ${cleanEmail}`);

    // Validate that the user account exists in MongoDB before generating reset link
    let existingUser = await userCollec.findOne({ email: cleanEmail });
    if (!existingUser) {
      return res.status(404).json({ error: "No account found with this email address." });
    }

    // Generate secure single-use token (32 bytes hex)
    let rawToken = crypto.randomBytes(32).toString("hex");

    // Store hashed token in MongoDB user document
    let hashedToken = crypto.createHash("sha256").update(rawToken).digest("hex");
    let expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 minutes expiration

    await userCollec.updateOne(
      { _id: existingUser._id },
      {
        $set: {
          resetPasswordToken: hashedToken,
          resetPasswordExpires: expiresAt,
          updatedAt: new Date()
        }
      }
    );

    let clientUrl = process.env.CLIENT_URL || "http://localhost:5173";
    let resetLink = `${clientUrl}/change?token=${rawToken}`;

    // Send the password reset email to the user-entered email address
    let emailResult = await sendPasswordResetEmail(cleanEmail, resetLink);

    if (!emailResult.success) {
      console.error(`[Forgot Password] Failed to send email to ${cleanEmail}:`, emailResult.error);
      return res.status(500).json({
        error: emailResult.error || "Failed to send password reset email."
      });
    }

    console.log(`[Forgot Password] Reset email delivered to ${cleanEmail}. ID: ${emailResult.id}`);

    res.json({
      success: true,
      message: `Password reset link sent to ${cleanEmail}! Check your inbox (and spam folder) 📬`,
      recipient: cleanEmail,
      emailId: emailResult.id
    });
  } catch (err) {
    console.error("Forgot password handler error:", err);
    res.status(500).json({
      error: err.message || "An unexpected error occurred while processing password reset."
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
    if (!token || !newPassword) {
      return res.status(400).json({ error: "Token and new password are required" });
    }

    if (typeof newPassword !== "string" || newPassword.length < 6) {
      return res.status(400).json({ error: "Password must be at least 6 characters long" });
    }

    let hashedToken = crypto.createHash("sha256").update(token).digest("hex");

    let user = await userCollec.findOne({ resetPasswordToken: hashedToken });
    if (!user) {
      return res.status(400).json({ error: "Invalid or already used password reset token." });
    }

    if (!user.resetPasswordExpires || new Date(user.resetPasswordExpires) < new Date()) {
      return res.status(400).json({ error: "This password reset token has expired." });
    }

    // Clean up single-use reset token (Firebase Auth is single source of truth for passwords)
    await userCollec.updateOne(
      { _id: user._id },
      {
        $set: {
          passwordUpdatedAt: new Date()
        },
        $unset: {
          password: "",
          resetPasswordToken: "",
          resetPasswordExpires: ""
        }
      }
    );

    console.log(`[Reset Password] Completed for ${user.email}. Token invalidated.`);

    res.json({ success: true, message: "Password updated successfully! You can now sign in with your new password." });
  } catch (err) {
    console.error("Reset password error:", err);
    res.status(500).json({ error: err.message || "Failed to reset password" });
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
      if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    methods: ["GET", "POST"],
    credentials: true,
  }
});

io.on("connection", (socket) => {
  socket.on("getHistory", () => {
    messageCollec.find().toArray()
      .then((result) => socket.emit("history", result))
      .catch((err) => console.error("getHistory error:", err));
  });

  socket.on("message", (data) => {
    messageCollec.insertOne(data)
      .catch((err) => console.error("Message insert error:", err));
    io.emit("message", data);
  });

  socket.on("disconnect", () => {});
});

// Render sets PORT automatically; fall back to 3000 for local dev
let PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => console.log(`NovaChat backend running on port ${PORT}`));