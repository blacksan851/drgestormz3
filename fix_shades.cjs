const fs = require('fs');
const path = require('path');

const files = [
  'src/Layout.tsx',
  'src/pages/Dashboard.tsx',
  'src/pages/Apps.tsx',
  'src/pages/PaySuite.tsx',
  'src/pages/Checkout.tsx',
  'src/App.tsx'
];

files.forEach(file => {
  const filePath = path.join(__dirname, file);
  if (fs.existsSync(filePath)) {
    let content = fs.readFileSync(filePath, 'utf8');
    content = content.replace(/to-zinc-500/g, 'to-emerald-500');
    content = content.replace(/from-green-500/g, 'from-green-400');
    content = content.replace(/bg-green-100/g, 'bg-emerald-100');
    // For shadows
    content = content.replace(/shadow-green-500\/20/g, 'shadow-emerald-500/20');
    content = content.replace(/fuchsia-/g, 'green-'); // Just to be sure there are no leftovers
    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Fixed shades in ' + file);
  }
});
