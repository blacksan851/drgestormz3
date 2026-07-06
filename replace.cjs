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

    // Replace names
    content = content.replace(/PAYSUIT HUB/g, 'DR GESTOR PAYMENT');
    content = content.replace(/PAYSUIT/g, 'DR GESTOR');
    content = content.replace(/PaySuit/g, 'Dr Gestor');
    content = content.replace(/paysuit/g, 'dr-gestor');

    // Replace colors for light/dark theme to use white and green
    content = content.replace(/indigo-950/g, 'zinc-950');
    content = content.replace(/indigo-900/g, 'zinc-900');
    content = content.replace(/indigo-800/g, 'zinc-800');
    content = content.replace(/indigo-700/g, 'zinc-700');
    
    content = content.replace(/indigo-400/g, 'zinc-400');
    content = content.replace(/indigo-300/g, 'zinc-300');
    content = content.replace(/indigo-200/g, 'zinc-200');
    content = content.replace(/indigo-100/g, 'zinc-100');
    content = content.replace(/indigo-50/g, 'zinc-50');

    content = content.replace(/indigo-600/g, 'emerald-600');
    content = content.replace(/indigo-500/g, 'emerald-500');

    content = content.replace(/fuchsia-/g, 'green-');
    
    content = content.replace(/from-zinc-900\/40 via-zinc-950 to-zinc-950/g, 'from-emerald-900/20 via-zinc-950 to-zinc-950');

    fs.writeFileSync(filePath, content, 'utf8');
    console.log('Updated ' + file);
  }
});
