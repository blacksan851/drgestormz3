const fs = require('fs');
const path = require('path');

const file = 'src/pages/Dashboard.tsx';
const filePath = path.join(__dirname, file);
if (fs.existsSync(filePath)) {
  let content = fs.readFileSync(filePath, 'utf8');
  content = content.replace(/#6366f1/g, '#059669'); // indigo-500 -> emerald-600
  content = content.replace(/#a5b4fc/g, '#6ee7b7'); // indigo-300 -> emerald-300
  content = content.replace(/#d946ef/g, '#10b981'); // fuchsia-500 -> emerald-500
  content = content.replace(/#312e81/g, '#064e3b'); // indigo-900 -> emerald-900
  content = content.replace(/#1e1b4b/g, '#022c22'); // indigo-950 -> emerald-950
  
  content = content.replace(/rgba\(99, 102, 241/g, 'rgba(16, 185, 129'); // indigo rgb -> emerald rgb
  
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('Fixed chart colors in ' + file);
}
