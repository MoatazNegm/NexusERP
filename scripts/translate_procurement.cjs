// Script to replace all hardcoded English strings in ProcurementModule.tsx with t() calls
const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, '..', 'components', 'ProcurementModule.tsx');
let content = fs.readFileSync(filePath, 'utf-8');

const replacements = [
  // === HEADER & TITLE ===
  [`{activeTab === 'outsourcing' ? t('procurement.tabs.outsourcing') || 'Outsourcing Workflow' : t('procurement.title') || 'Commercial Procurement'}`,
   `{activeTab === 'outsourcing' ? t('procurement.outsourcingTitle') : t('procurement.title')}`],

  // Subtitle
  [`{activeTab === 'outsourcing' \n                    ? \`Operational Services • \${outsourcingGroups.length} Orders Pending Action\` \n                    : \`Supply Chain Orchestration • \${purchaseGroups.length} Orders Pending Action\`}`,
   `{activeTab === 'outsourcing' \n                    ? \`\${t('procurement.subtitle.operationalServices')} • \${outsourcingGroups.length} \${t('procurement.subtitle.ordersPending')}\` \n                    : \`\${t('procurement.subtitle.supplyChain')} • \${purchaseGroups.length} \${t('procurement.subtitle.ordersPending')}\`}`],

  // Sort bar
  [`>Priority Sort:<`, `>{t('procurement.sort.prioritySort')}:<`],
  [`{ key: 'orderDate', label: 'PO Received' }`, `{ key: 'orderDate', label: t('procurement.sort.poReceived') }`],
  [`{ key: 'customer', label: 'Entity' }`, `{ key: 'customer', label: t('procurement.sort.entity') }`],
  [`{ key: 'customerReferenceNumber', label: 'PO #' }`, `{ key: 'customerReferenceNumber', label: t('procurement.sort.poHash') }`],
  [`{ key: 'internalOrderNumber', label: 'Int ID' }`, `{ key: 'internalOrderNumber', label: t('procurement.sort.intId') }`],

  // Component list items
  [`items factory-ready`, `{t('procurement.component.factoryReady')}`],
  [`>{comps.length} components<`, `>{comps.length} {t('procurement.component.components')}<`],

  // Rollback button
  [`{anyOrdered ? 'POs Active — Rollback Locked' : 'Rollback Order'}`,
   `{anyOrdered ? t('procurement.actions.rollbackLocked') : t('procurement.actions.rollbackOrder')}`],
  [`title={anyOrdered ? 'POs Active — Rollback Locked' : 'Rollback to Logged Registry'}`,
   `title={anyOrdered ? t('procurement.actions.rollbackLocked') : t('procurement.actions.rollbackOrder')}`],

  // Issue PO for All
  [`> Issue PO for All`, `> {t('procurement.po.issuePOAll')}`],

  // Not all ready messages
  [`Not all line items ready for PO`, `{t('procurement.actions.notAllReady')}`],
  [`All components must be awarded for PO`, `{t('procurement.actions.allMustBeAwarded')}`],

  // Component detail labels - received/left/supplier
  [`>• Received: {c.receivedQty}<`, `>• {t('procurement.component.received')}: {c.receivedQty}<`],
  [`>• Left: {Math.max`, `>• {t('procurement.component.left')}: {Math.max`],
  [`• Supplier: {suppliers.find(s => s.id === c.supplierId)?.name || 'Unknown'}`,
   `• {t('procurement.component.supplier')}: {suppliers.find(s => s.id === c.supplierId)?.name || t('procurement.component.unknown')}`],

  // Contract dates display
  [`>Start: {new Date(c.contractStartDate).toLocaleDateString()}`,
   `>{t('procurement.component.start')}: {new Date(c.contractStartDate).toLocaleDateString()}`],
  [`• End: {endDate.toLocaleDateString()} ✓`, `• {t('procurement.component.end')}: {endDate.toLocaleDateString()} ✓`],
  [`• Duration: {c.contractDuration}`, `• {t('procurement.rfp.duration')}: {c.contractDuration}`],

  // Revive Contract button
  [`> Revive Contract`, `> {t('procurement.actions.reviveContract')}`],

  // RFP section buttons
  [`> Download RFP`, `> {t('procurement.rfp.downloadRfp')}`],
  [`>All components must be awarded first<`, `>{t('procurement.actions.allMustBeAwarded')}<`],

  // Issue PO single button
  [`>Issue PO\n                    </button>`, `>{t('procurement.rfp.issuePO')}\n                    </button>`],
  [`>Issue PO<`, `>{t('procurement.rfp.issuePO')}<`],

  // Reset Award button
  [`>Reset Award\n                                   </button>`, `>{t('procurement.rfp.resetAward')}\n                                   </button>`],

  // Financial Breach
  [`Financial Breach: PO Blocked`, `{t('procurement.actions.financialBreach')}`],

  // Download PO buttons
  [`> Download PO`, `> {t('procurement.po.downloadPO')}`],

  // Cancel Order buttons
  [`> Cancel Order`, `> {t('procurement.actions.cancelOrder')}`],

  // Revert to Award buttons
  [`> Revert to Award`, `> {t('procurement.actions.revertToAward')}`],

  // Resource Replacement button
  [`> Resource Replacement`, `> {t('procurement.actions.resourceReplacement')}`],

  // Empty state messages
  [`{activeTab === 'outsourcing' ? 'No active outsourcing tasks.' : 'Commercial procurement pipeline is empty.'}`,
   `{activeTab === 'outsourcing' ? t('procurement.actions.noActive') : t('procurement.actions.pipelineEmpty')}`],

  // === MODAL TITLES ===
  [`{activeAction.type === 'RFP' ? 'Issue Request for Proposals' :\n                          activeAction.type === 'AWARD' ? 'Commercial Award Selection' :\n                            activeAction.type === 'RESET' ? 'Reset Sourcing Cycle' :\n                              activeAction.type === 'ORDER_ROLLBACK' ? 'Order Workflow Rollback' :\n                                activeAction.type === 'REVIVE_CONTRACT' ? 'Revive Expired Contract' : 'Confirm Purchase Order'}`,
   `{activeAction.type === 'RFP' ? t('procurement.rfp.issueRfp') :\n                          activeAction.type === 'AWARD' ? t('procurement.award.title') :\n                            activeAction.type === 'RESET' ? t('procurement.reset.title') :\n                              activeAction.type === 'ORDER_ROLLBACK' ? t('procurement.rollback.title') :\n                                activeAction.type === 'REVIVE_CONTRACT' ? t('procurement.revive.title') : t('procurement.po.confirmPO')}`],

  // Modal subtitle
  [`{activeAction.type === 'ORDER_ROLLBACK' ? \`Reverting to Logged Registry: \${activeAction.order.internalOrderNumber}\` : \`Comp: \${activeAction.comp?.description}\`}`,
   `{activeAction.type === 'ORDER_ROLLBACK' ? \`\${t('procurement.rollback.revertingToLogged')}: \${activeAction.order.internalOrderNumber}\` : \`\${t('procurement.rfp.component')}: \${activeAction.comp?.description}\`}`],

  // RFP Modal labels
  [`>Components to include in RFP<`, `>{t('procurement.rfp.componentsInRfp')}<`],
  [`>Select other components from this order to group into a single request.<`, `>{t('procurement.rfp.componentsInRfpHint')}<`],
  [`{isDownloadingRfp ? 'Generating Request Document...' : 'Download Vendor RFP Document'}`,
   `{isDownloadingRfp ? t('procurement.rfp.generatingRfpDoc') : t('procurement.rfp.downloadVendorRfp')}`],
  [`>Select at least one component to generate PDF<`, `>{t('procurement.rfp.selectAtLeastOne')}<`],
  [`>Select Target Suppliers (Optional)<`, `>{t('procurement.rfp.selectTargetSuppliers')}<`],
  [`>If none selected, Award Tender will show all available vendors.<`, `>{t('procurement.rfp.selectTargetSuppliersHint')}<`],

  // AWARD modal
  [`>Total Quantity<`, `>{t('procurement.award.totalQuantity')}<`],
  [`>Sourcing Code<`, `>{t('procurement.award.sourcingCode')}<`],
  [`>Matching Components in RFP<`, `>{t('procurement.award.matchingComponents')}<`],
  [`>Price per {mc.unit || 'Item'}<`, `>{t('procurement.award.pricePerUnit')} {mc.unit || t('procurement.component.item')}<`],
  [`>Award Winning Vendor<`, `>{t('procurement.award.awardVendor')}<`],
  [`>Select Vendor...<`, `>{t('procurement.award.selectVendor')}<`],
  [`>Global Tax Percentage (%)<`, `>{t('procurement.award.globalTaxPercent')}<`],
  [`>Total Cost Without Tax<`, `>{t('procurement.award.totalExclTax')}<`],
  [`>Tax Amount ({awardTaxPercent}%)<`, `>{t('procurement.award.taxAmount')} ({awardTaxPercent}%)<`],
  [`>Total Award Value (Incl. Tax)<`, `>{t('procurement.award.totalInclTax')}<`],

  // PO Modal
  [`>Target Supplier<`, `>{t('procurement.po.targetSupplier')}<`],
  [`|| 'Unknown Supplier'`, `|| t('procurement.component.unknown')`],
  [`>Order Ref<`, `>{t('procurement.po.orderRef')}<`],
  [`>Include in Purchase Order<`, `>{t('procurement.po.includeInPO')}<`],
  [`>System Purchase Order ID<`, `>{t('procurement.po.systemPOId')}<`],
  [`>Contract/Service Number (Outsourcing)<`, `>{t('procurement.po.contractServiceNumber')}<`],
  [`placeholder="Contract number is set from Technical Review"`, `placeholder={t('procurement.po.contractNumberReadOnly')}`],
  [`>Pre-filled from Technical Review and not editable here.<`, `>{t('procurement.po.contractNumberHint')}<`],
  [`>Contract Start Date (Outsourcing)<`, `>{t('procurement.po.contractStartDate')}<`],
  [`Past start dates are prohibited unless the checkbox is checked.`,
   `{t('procurement.po.pastDatesProhibited')}`],
  [`Allow a past contract start date`, `{t('procurement.po.allowPastStart')}`],

  // Cancel PO Modal
  [`>Cancelling PO<`, `>{t('procurement.cancelPO.title')}<`],
  [`>Components<`, `>{t('procurement.cancelPO.affectedComponents')}<`],
  [`>Affected Components<`, `>{t('procurement.cancelPO.affectedComponents')}<`],
  [`Strategic Rollback: Reverting these components to the RFP stage. A mandatory comment is required for the audit trail.`,
   `{t('procurement.cancelPO.strategicRollback')}`],
  [`>Reason for Cancellation<`, `>{t('procurement.cancelPO.reasonForCancellation')}<`],

  // Revert PO Modal
  [`>Reverting PO to Award<`, `>{t('procurement.revertPO.title')}<`],
  [`>PO Number<`, `>{t('procurement.po.poNumber')}<`],
  [`This component will be reverted from ORDERED/WAITING_CONTRACT_START back to AWARDED status. This allows you to modify the award or issue a new PO.`,
   `{t('procurement.revertPO.warningRevert')}`],
  [`Note: This may re-enable "Issue PO" buttons on other line items if they were blocked by order-wide readiness.`,
   `{t('procurement.revertPO.noteRevert')}`],

  // Revert to Pending Modal
  [`>Reverting Award to Pending<`, `>{t('procurement.revertToPending.title')}<`],
  [`>Component ID<`, `>{t('procurement.revertToPending.componentId')}<`],
  [`This component will be reverted from AWARDED back to PENDING_OFFER status. This allows you to restart the sourcing process from RFP.`,
   `{t('procurement.revertToPending.warningPending')}`],
  [`All "Issue PO" buttons in this order will be DISABLED until ALL components are awarded again.`,
   `{t('procurement.revertToPending.importantNote')}`],

  // Revive Contract Modal
  [`>Reviving Contract<`, `>{t('procurement.revive.title')}<`],
  [`>Old End Date<`, `>{t('procurement.revive.oldEndDate')}<`],
  [`This extension will not incur any payment request from the customer.`,
   `{t('procurement.revive.extensionHint')}`],
  [`If a payment is needed, a new contract PO should be issued and this contract should be ended properly instead.`,
   `{t('procurement.revive.extensionPaymentHint')}`],
  [`>Reason for reviving<`, `>{t('procurement.revive.reasonForReviving')}<`],
  [`> Add Extension`, `> {t('procurement.revive.addExtension')}`],
  [`> Pick End Date`, `> {t('procurement.revive.pickEndDate')}`],
  [`>Extension Duration (Months)<`, `>{t('procurement.revive.extensionDuration')}<`],
  [`>New Contract End Date<`, `>{t('procurement.revive.newContractEndDate')}<`],

  // Reset / Rollback Modal
  [`{activeAction.type === 'RESET'\n                            ? 'Warning: This will void current sourcing progress and return the component to "Pending Offer".'\n                            : 'Strategic Action: Reverting this entire order will move it back to the "Logged Registry". This should only be used to correct major entry errors.'\n                          }`,
   `{activeAction.type === 'RESET'\n                            ? t('procurement.reset.warningReset')\n                            : t('procurement.rollback.warningRollback')\n                          }`],
  [`>Mandatory Operational Reason<`, `>{t('procurement.reset.mandatoryReason')}<`],

  // Bottom modal buttons
  [`>Abort<`, `>{t('procurement.abort')}<`],
  [`{activeAction.type === 'RFP' ? 'Broadcast RFP' : activeAction.type === 'AWARD' ? 'Confirm Award' : activeAction.type === 'RESET' ? 'Confirm Reset' : activeAction.type === 'ORDER_ROLLBACK' ? 'Execute Rollback' : activeAction.type === 'CANCEL_PO_BATCH' ? 'Confirm Cancellation' : activeAction.type === 'REVERT_PO' ? 'Confirm Revert' : activeAction.type === 'REVERT_TO_PENDING' ? 'Confirm Revert to Pending' : activeAction.type === 'REVIVE_CONTRACT' ? 'Revive Contract' : 'Commit Procurement'}`,
   `{activeAction.type === 'RFP' ? t('procurement.rfp.broadcastRfp') : activeAction.type === 'AWARD' ? t('procurement.award.confirmAward') : activeAction.type === 'RESET' ? t('procurement.reset.confirmReset') : activeAction.type === 'ORDER_ROLLBACK' ? t('procurement.rollback.executeRollback') : activeAction.type === 'CANCEL_PO_BATCH' ? t('procurement.cancelPO.confirmCancellation') : activeAction.type === 'REVERT_PO' ? t('procurement.revertPO.confirmRevert') : activeAction.type === 'REVERT_TO_PENDING' ? t('procurement.revertToPending.confirmRevertPending') : activeAction.type === 'REVIVE_CONTRACT' ? t('procurement.revive.reviveContract') : t('procurement.commitProcurement')}`],

  // Replacement Modal
  [`>Request Resource Replacement<`, `>{t('procurement.replacement.title')}<`],
  [`>Contract Information<`, `>{t('procurement.replacement.contractInfo')}<`],
  [`>Contract Start Date<`, `>{t('procurement.replacement.contractStartDate')}<`],
  [`|| 'Not Set'`, `|| t('procurement.replacement.notSet')`],
  [`'✓ Contract Already Started'`, `'✓ ' + t('procurement.replacement.contractAlreadyStarted')`],
  [`>Detailed Reason for Replacement<`, `>{t('procurement.replacement.reasonForReplacement')}<`],
  [`placeholder="Explain why this outsourced resource is being replaced..."`, `placeholder={t('procurement.replacement.reasonPlaceholder')}`],
  [`>New Resource Start Date<`, `>{t('procurement.replacement.newResourceStartDate')}<`],
  [`>Cancel\n                  </button>`, `>{t('common.cancel')}\n                  </button>`],
  [`>Submit & Extract PDF<`, `>{t('procurement.replacement.submitExtractPdf')}<`],

  // Resolution Modal
  [`>Outstanding Supplier Commitments<`, `>{t('procurement.resolution.title')}<`],
  [`> Cancel Supplier PO`, `> {t('procurement.resolution.cancelSupplierPO')}`],
  [`> Receive to Stock`, `> {t('procurement.resolution.receiveToStock')}`],
  [`>Confirm Resolutions & Continue\n                    <`, `>{t('procurement.resolution.confirmResolutions')}\n                    <`],
  [`Confirm Resolutions & Continue\n                    </button>`, `{t('procurement.resolution.confirmResolutions')}\n                    </button>`],
  
  // Resolution modal - status texts
  [`{rec.status === 'ORDERED' ? 'PO Issued — Awaiting Delivery' : rec.status === 'WAITING_CONTRACT_START' ? 'Awaiting Contract Start' : 'Awarded — Pending PO Issuance'}`,
   `{rec.status === 'ORDERED' ? t('procurement.resolution.poIssued') : rec.status === 'WAITING_CONTRACT_START' ? t('procurement.resolution.awaitingContractStart') : t('procurement.resolution.awardedPendingPO')}`],

  // Resolution modal texts
  [`The following components have active supplier commitments. You must decide the fate of each before rolling back this order:`,
   `{t('procurement.resolution.resolveMsg')}`],

  // Move LanguageToggle to top-left (before the title instead of inline with it)
  [`<span className="ml-3"><LanguageToggle /></span>`, ``],
];

let changeCount = 0;
for (const [search, replace] of replacements) {
  if (content.includes(search)) {
    content = content.replace(search, replace);
    changeCount++;
  }
}

// Now add the LanguageToggle at the top before the title area - find the title container
content = content.replace(
  `<div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-10">\n              <div>\n                <h2 className="text-3xl font-black text-slate-800 uppercase tracking-tight flex items-center gap-4">`,
  `<div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-6 mb-10">\n              <div className="flex items-center gap-4">\n                <LanguageToggle />\n                <div>\n                <h2 className="text-3xl font-black text-slate-800 uppercase tracking-tight flex items-center gap-4">`
);

// Close the extra div wrapper after the subtitle paragraph
content = content.replace(
  `</p>\n              </div>\n\n              {/* Sorting Bar */}`,
  `</p>\n              </div>\n              </div>\n\n              {/* Sorting Bar */}`
);

fs.writeFileSync(filePath, content, 'utf-8');
console.log(`Done! Applied ${changeCount} replacements to ProcurementModule.tsx`);
