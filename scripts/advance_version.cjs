const fs = require('fs');
const path = require('path');

const packageJsonPath = path.join(process.cwd(), 'package.json');
const packageLockJsonPath = path.join(process.cwd(), 'package-lock.json');
const constantsPath = path.join(process.cwd(), 'constants.tsx');

// 1. Update package.json & package-lock.json version
if (fs.existsSync(packageJsonPath)) {
  try {
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const version = packageJson.version || '0.0.0';
    const parts = version.split('.');

    if (parts.length === 3) {
      let patch = parts[2];
      if (patch.length < 7) {
        patch = patch.padEnd(7, '0');
      }
      const patchInt = parseInt(patch, 10) + 1;
      const newPatch = String(patchInt).padStart(patch.length, '0');
      parts[2] = newPatch;
      const newVersion = parts.join('.');
      
      packageJson.version = newVersion;
      fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf8');
      console.log(`Updated package.json version from ${version} to ${newVersion}`);

      if (fs.existsSync(packageLockJsonPath)) {
        const packageLockJson = JSON.parse(fs.readFileSync(packageLockJsonPath, 'utf8'));
        packageLockJson.version = newVersion;
        if (packageLockJson.packages && packageLockJson.packages['']) {
          packageLockJson.packages[''].version = newVersion;
        }
        fs.writeFileSync(packageLockJsonPath, JSON.stringify(packageLockJson, null, 2) + '\n', 'utf8');
        console.log(`Updated package-lock.json version to ${newVersion}`);
      }
    }
  } catch (err) {
    console.error('Error updating package.json / package-lock.json version:', err);
  }
}

// 2. Update APP_VERSION in constants.tsx
if (fs.existsSync(constantsPath)) {
  try {
    let content = fs.readFileSync(constantsPath, 'utf8');
    const match = content.match(/export\s+const\s+APP_VERSION\s*=\s*['"]([^'"]+)['"]/);
    if (match) {
      const oldVersion = match[1];
      const parts = oldVersion.split('.');
      if (parts.length === 2) {
        let decimalPart = parts[1];
        const decimalInt = parseInt(decimalPart, 10) + 1;
        const newDecimalPart = String(decimalInt).padStart(decimalPart.length, '0');
        const newVersion = `${parts[0]}.${newDecimalPart}`;
        
        content = content.replace(
          /export\s+const\s+APP_VERSION\s*=\s*['"][^'"]+['"]/,
          `export const APP_VERSION = '${newVersion}'`
        );
        fs.writeFileSync(constantsPath, content, 'utf8');
        console.log(`Updated constants.tsx APP_VERSION from ${oldVersion} to ${newVersion}`);
      } else {
        console.error(`Error: APP_VERSION in constants.tsx is not in X.Y format: ${oldVersion}`);
      }
    } else {
      console.error('Error: Could not find APP_VERSION in constants.tsx');
    }
  } catch (err) {
    console.error('Error updating constants.tsx APP_VERSION:', err);
  }
} else {
  console.log('constants.tsx not found, skipped constants version update.');
}
