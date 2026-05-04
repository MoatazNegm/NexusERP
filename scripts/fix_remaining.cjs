const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'components', 'ProcurementModule.tsx');
let content = fs.readFileSync(filePath, 'utf-8');

// Fix 1: Add LanguageToggle wrapper around the title div
content = content.replace(
  '<div>\r\n                <h2 className="text-3xl font-black text-slate-800 uppercase tracking-tight flex items-center gap-4">\r\n                  {activeTab === \'outsourcing\' ? t(\'procurement.outsourcingTitle\') : t(\'procurement.title\')}',
  '<div className="flex items-center gap-4">\r\n                <LanguageToggle />\r\n                <div>\r\n                <h2 className="text-3xl font-black text-slate-800 uppercase tracking-tight flex items-center gap-4">\r\n                  {activeTab === \'outsourcing\' ? t(\'procurement.outsourcingTitle\') : t(\'procurement.title\')}'
);

// Fix 2: Close the extra wrapper div after </p></div>
content = content.replace(
  '</p>\r\n              </div>\r\n\r\n              {/* Sorting Bar */}',
  '</p>\r\n              </div>\r\n              </div>\r\n\r\n              {/* Sorting Bar */}'
);

// Fix 3: Translate the subtitle
content = content.replace(
  "`Operational Services • ${outsourcingGroups.length} Orders Pending Action`",
  "`${t('procurement.subtitle.operationalServices')} • ${outsourcingGroups.length} ${t('procurement.subtitle.ordersPending')}`"
);
content = content.replace(
  "`Supply Chain Orchestration • ${purchaseGroups.length} Orders Pending Action`",
  "`${t('procurement.subtitle.supplyChain')} • ${purchaseGroups.length} ${t('procurement.subtitle.ordersPending')}`"
);

// Fix 4: Translate "components" text in component count
content = content.replace(
  '>{comps.length} components<',
  '>{comps.length} {t(\'procurement.component.components\')}<'
);

// Fix 5: Fix "items factory-ready" text
content = content.replace(
  'items factory-ready',
  '{t(\'procurement.component.factoryReady\')}'
);

// Fix 6: Translate remaining "Abort" in resolution modal at the bottom
content = content.replace(
  />\r?\n\s*Abort\r?\n\s*<\/button>/,
  '>\r\n                      {t(\'procurement.abort\')}\r\n                    </button>'
);

fs.writeFileSync(filePath, content, 'utf-8');
console.log('Done! Applied remaining fixes.');
