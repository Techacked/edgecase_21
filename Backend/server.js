const express = require("express");
const multer = require("multer");
const { spawn } = require("child_process");
const path = require("path");
const cors = require("cors");

const app = express();
const port = 5000;

// Enable CORS so frontend can access backend
app.use(cors());

// Storage config for uploaded images
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "uploads/"); // folder for uploaded files
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  },
});

const upload = multer({ storage: storage });

// Route to handle image upload and prediction
app.post("/predict", upload.single("image"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" });
  }

  // Call Python script with uploaded file path
  const pythonProcess = spawn("python", ["predict.py", req.file.path]);

  let result = "";
  pythonProcess.stdout.on("data", (data) => {
    result += data.toString();
  });

  pythonProcess.stderr.on("data", (data) => {
    console.error(`stderr: ${data}`);
  });

  pythonProcess.on("close", (code) => {
    console.log(`Python process exited with code ${code}`);

    // Clean the result: remove ANSI codes and pick the last line
    const prediction = result.replace(/\u001b\[[0-9;]*m/g, '').trim().split("\n").pop();
    
    // Send clean JSON response to frontend
    res.json({ prediction });
  });
});

// Start the server
app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
