const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("Usage: node convert_backup_format.js <path-to-old-backup.nxarchive>");
  process.exit(1);
}

const inputPath = path.resolve(args[0]);
if (!fs.existsSync(inputPath)) {
  console.error(`File not found: ${inputPath}`);
  process.exit(1);
}

const outputPath = inputPath.replace('.nxarchive', '-converted.nxarchive');

try {
  // Read the entire old backup
  const fileBuffer = fs.readFileSync(inputPath);
  
  if (fileBuffer.length < 44) {
    console.error("File is too small to be a valid backup.");
    process.exit(1);
  }

  // Parse old format: [16 bytes salt] [12 bytes IV] [16 bytes AuthTag] [Encrypted Payload]
  const salt = fileBuffer.subarray(0, 16);
  const iv = fileBuffer.subarray(16, 28);
  const authTag = fileBuffer.subarray(28, 44);
  const encrypted = fileBuffer.subarray(44);

  // New format: [16 bytes salt] [12 bytes IV] [Encrypted Payload] [16 bytes AuthTag]
  const newBuffer = Buffer.concat([salt, iv, encrypted, authTag]);

  // Write new file
  fs.writeFileSync(outputPath, newBuffer);
  
  console.log("=========================================");
  console.log("✅ Backup Converted Successfully!");
  console.log("=========================================");
  console.log(`Original Size: ${(fileBuffer.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`New Size: ${(newBuffer.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`Saved as: ${outputPath}`);
  console.log("\nYou can now safely upload this file using the Restore tool.");

} catch (err) {
  console.error("Failed to convert backup:", err);
}
