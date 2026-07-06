const fs = require('fs');
const path = require('path');

const fixFile = (file, replacements) => {
  const filePath = path.join(__dirname, file);
  if (!fs.existsSync(filePath)) return;
  let content = fs.readFileSync(filePath, 'utf8');
  replacements.forEach(([regex, replaceValue]) => {
    content = content.replace(regex, replaceValue);
  });
  fs.writeFileSync(filePath, content, 'utf8');
  console.log('Fixed ' + file);
};

// Layout.tsx
fixFile('src/Layout.tsx', [
  [/Dr Gestore/g, 'DrGestorPayment'],
  [/'\/dr-gestore'/g, "'/dr-gestor-payment'"]
]);

// App.tsx
fixFile('src/App.tsx', [
  [/import Dr Gestore from '\.\/pages\/Dr Gestore';/g, "import DrGestorPayment from './pages/PaySuite';"],
  [/<Dr Gestore \/>/g, "<DrGestorPayment />"],
  [/"\/dr-gestore"/g, '"/dr-gestor-payment"']
]);

// PaySuite.tsx
fixFile('src/pages/PaySuite.tsx', [
  [/export default function Dr Gestore/g, 'export default function DrGestorPayment'],
  [/https:\/\/.*\.lovable\.app\/api\/public\/dr-gestore-webhook/g, 'https://drgestor.com/api/public/webhook'],
  [/dr-gestore-signature/g, 'dr-gestor-signature'],
  [/dr-gestore-owner/g, 'dr-gestor-owner']
]);

