const fs = require('fs');
const path = require('path');

// === Fix 1: Move LanguageToggle in ProcurementModule to be adjacent to tabs ===
const procPath = path.join(__dirname, '..', 'components', 'ProcurementModule.tsx');
let proc = fs.readFileSync(procPath, 'utf-8');

// Remove old toggle from the title area
proc = proc.replace(
  '<div className="flex items-center gap-4">\r\n                <LanguageToggle />\r\n                <div>\r\n                <h2',
  '<div>\r\n                <h2'
);
// Remove the extra closing div that wrapped the toggle
proc = proc.replace(
  '</p>\r\n              </div>\r\n              </div>',
  '</p>\r\n              </div>'
);

// Add LanguageToggle right before the tab bar div
proc = proc.replace(
  '      {/* Tab Bar */}\r\n      <div className="flex gap-1 bg-white p-1.5 rounded-2xl shadow-sm border border-slate-200 w-fit">',
  '      {/* Tab Bar */}\r\n      <div className="flex items-center gap-3">\r\n      <LanguageToggle />\r\n      <div className="flex gap-1 bg-white p-1.5 rounded-2xl shadow-sm border border-slate-200 w-fit">'
);

// Close the wrapper div after the tab bar closing
proc = proc.replace(
  '      </div>\r\n\r\n      {activeTab === \'history\'',
  '      </div>\r\n      </div>\r\n\r\n      {activeTab === \'history\''
);

fs.writeFileSync(procPath, proc, 'utf-8');
console.log('ProcurementModule: Moved LanguageToggle to tab bar.');

// === Fix 2: Translate PartHistory.tsx ===
const histPath = path.join(__dirname, '..', 'components', 'PartHistory.tsx');
let hist = fs.readFileSync(histPath, 'utf-8');

// Add useLanguage import
hist = hist.replace(
  "import React, { useState, useMemo } from 'react';",
  "import React, { useState, useMemo } from 'react';\nimport { useLanguage } from '../contexts/LanguageContext';"
);

// Add hook inside the component
hist = hist.replace(
  'export const PartHistory: React.FC<PartHistoryProps> = ({ orders, suppliers }) => {\r\n    const [search, setSearch] = useState(\'\');',
  'export const PartHistory: React.FC<PartHistoryProps> = ({ orders, suppliers }) => {\r\n    const { t, language } = useLanguage();\r\n    const isAr = language === \'ar\';\r\n    const [search, setSearch] = useState(\'\');'
);

// Update column header rendering to use Arabic labels when needed
hist = hist.replace(
  '<span>{activeTab === \'contracts\' ? colMeta[key].contractLabel : colMeta[key].label}</span>',
  '<span>{isAr ? colMeta[key].labelAr : (activeTab === \'contracts\' ? colMeta[key].contractLabel : colMeta[key].label)}</span>'
);

// Now replace all the hardcoded labels in the JSX

// Main Title
hist = hist.replace(
  "{activeTab === 'contracts' ? 'Outsourcing Contract History' : 'Part & Component History'}",
  "{isAr ? (activeTab === 'contracts' ? 'سجل عقود التعهيد' : 'سجل القطع والمكونات') : (activeTab === 'contracts' ? 'Outsourcing Contract History' : 'Part & Component History')}"
);

// Subtitle
hist = hist.replace(
  "Complete {activeTab === 'contracts' ? 'Contract' : 'Part'} Registry • {typedParts.length} Records • Drag column headers to reorder",
  "{isAr ? `سجل ${activeTab === 'contracts' ? 'العقود' : 'القطع'} الكامل • ${typedParts.length} سجلات • اسحب رؤوس الأعمدة لإعادة الترتيب` : `Complete ${activeTab === 'contracts' ? 'Contract' : 'Part'} Registry • ${typedParts.length} Records • Drag column headers to reorder`}"
);

// Parts/Contracts sub-tabs
hist = hist.replace(
  />\r?\n\s*Parts\r?\n\s*<\/button>/,
  '>\r\n                            {isAr ? \'القطع\' : \'Parts\'}\r\n                        </button>'
);
hist = hist.replace(
  />\r?\n\s*Contracts\r?\n\s*<\/button>/,
  '>\r\n                            {isAr ? \'العقود\' : \'Contracts\'}\r\n                        </button>'
);

// Search placeholder
hist = hist.replace(
  'placeholder="Search by part number, description, supplier..."',
  'placeholder={isAr ? "بحث برقم القطعة، الوصف، المورد..." : "Search by part number, description, supplier..."}'
);

// Order Ref table header
hist = hist.replace(
  '>Order Ref</th>',
  '>{isAr ? \'مرجع الطلب\' : \'Order Ref\'}</th>'
);

// Expanded detail section headers
hist = hist.replace(
  '> Component Details',
  '> {isAr ? \'تفاصيل المكون\' : \'Component Details\'}'
);
hist = hist.replace(
  '> Order Context',
  '> {isAr ? \'سياق الطلب\' : \'Order Context\'}'
);
hist = hist.replace(
  '> Tracking IDs',
  '> {isAr ? \'معرفات التتبع\' : \'Tracking IDs\'}'
);
hist = hist.replace(
  '> Order Activity Log',
  '> {isAr ? \'سجل نشاط الطلب\' : \'Order Activity Log\'}'
);
hist = hist.replace(
  '> Resource Replacement History',
  '> {isAr ? \'سجل استبدال الموارد\' : \'Resource Replacement History\'}'
);

// Detail labels in Component Details section
hist = hist.replace(/>Status<\/span>/g, '>{isAr ? \'الحالة\' : \'Status\'}</span>');
hist = hist.replace(/>Source<\/span>/, '>{isAr ? \'المصدر\' : \'Source\'}</span>');
hist = hist.replace(/>PO Number<\/span>/, '>{isAr ? \'رقم أمر الشراء\' : \'PO Number\'}</span>');
hist = hist.replace(/>Unit Cost<\/span>/, '>{isAr ? \'تكلفة الوحدة\' : \'Unit Cost\'}</span>');
hist = hist.replace(/>Total Cost<\/span>/, '>{isAr ? \'التكلفة الإجمالية\' : \'Total Cost\'}</span>');

// Order Context labels
hist = hist.replace(/>Customer<\/span>/, '>{isAr ? \'العميل\' : \'Customer\'}</span>');
hist = hist.replace(/>Order Ref<\/span>/, '>{isAr ? \'مرجع الطلب\' : \'Order Ref\'}</span>');
hist = hist.replace(/>Line Item<\/span>/, '>{isAr ? \'بند الطلب\' : \'Line Item\'}</span>');
hist = hist.replace(/>Supplier<\/span>/, '>{isAr ? \'المورد\' : \'Supplier\'}</span>');

// Tracking IDs labels
hist = hist.replace(/>RFP ID<\/span>/, '>{isAr ? \'رقم طلب العرض\' : \'RFP ID\'}</span>');
hist = hist.replace(/>Award ID<\/span>/, '>{isAr ? \'رقم الترسية\' : \'Award ID\'}</span>');
hist = hist.replace(/>PO Batch ID<\/span>/, '>{isAr ? \'رقم دفعة أمر الشراء\' : \'PO Batch ID\'}</span>');
hist = hist.replace(/>Procurement Started<\/span>/, '>{isAr ? \'بدء المشتريات\' : \'Procurement Started\'}</span>');
hist = hist.replace(/>Last Status Update<\/span>/, '>{isAr ? \'آخر تحديث للحالة\' : \'Last Status Update\'}</span>');

// Log user "by" label
hist = hist.replace(
  '>by {log.user}</span>',
  '>{isAr ? `بواسطة ${log.user}` : `by ${log.user}`}</span>'
);

// Replacement history labels
hist = hist.replace(
  ">Request Date: {formatDate(req.requestDate)}</span>",
  ">{isAr ? `تاريخ الطلب: ${formatDate(req.requestDate)}` : `Request Date: ${formatDate(req.requestDate)}`}</span>"
);
hist = hist.replace(
  ">Start: {formatDate(req.originalStartDate)}</span>",
  ">{isAr ? `البداية: ${formatDate(req.originalStartDate)}` : `Start: ${formatDate(req.originalStartDate)}`}</span>"
);
hist = hist.replace(
  ">New: {formatDate(req.newStartDate)}</span>",
  ">{isAr ? `الجديد: ${formatDate(req.newStartDate)}` : `New: ${formatDate(req.newStartDate)}`}</span>"
);

// Contract log detail
hist = hist.replace(
  "(Contract: {row.contractNumber || row.orderRef}, Duration: {row.contractDuration || 'N/A'}, Start Date: {row.contractStartDate ? formatDate(row.contractStartDate) : 'N/A'}, Reason: {row.scopeOfWork || row.description})",
  "{isAr ? `(العقد: ${row.contractNumber || row.orderRef}، المدة: ${row.contractDuration || 'غ/م'}، تاريخ البدء: ${row.contractStartDate ? formatDate(row.contractStartDate) : 'غ/م'}، السبب: ${row.scopeOfWork || row.description})` : `(Contract: ${row.contractNumber || row.orderRef}, Duration: ${row.contractDuration || 'N/A'}, Start Date: ${row.contractStartDate ? formatDate(row.contractStartDate) : 'N/A'}, Reason: ${row.scopeOfWork || row.description})`}"
);

// Empty state
hist = hist.replace(
  "{search ? 'No matching records found' : 'No component history available'}",
  "{isAr ? (search ? 'لا توجد سجلات مطابقة' : 'لا يوجد سجل مكونات متاح') : (search ? 'No matching records found' : 'No component history available')}"
);

fs.writeFileSync(histPath, hist, 'utf-8');
console.log('PartHistory: Fully translated with Arabic support.');
