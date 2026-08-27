
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { GoogleGenAI } from "@google/genai";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import mermaid from 'mermaid';
import { CustomerOrder, OrderStatus, AppConfig, User } from '../types';
import { getItemEffectiveQty } from '../utils';

interface AIAssistantProps {
  orders: CustomerOrder[];
  config: AppConfig;
  currentUser?: User | null;
}

const BENCHMARK_STORAGE_KEY = 'nexus_ocr_model_benchmarks_v2';

interface ModelBenchmark {
  model: string;
  status: 'healthy' | 'error';
  lastResponseTimeMs: number;
  avgResponseTimeMs: number;
  successCount: number;
  errorCount: number;
  lastSuccessTimestamp?: number;
  lastErrorTimestamp?: number;
  lastErrorMessage?: string;
}

const getModelBenchmarks = (): Record<string, ModelBenchmark> => {
  try {
    const raw = localStorage.getItem(BENCHMARK_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (_) {
    return {};
  }
};

const saveModelBenchmarks = (benchmarks: Record<string, ModelBenchmark>) => {
  try {
    localStorage.setItem(BENCHMARK_STORAGE_KEY, JSON.stringify(benchmarks));
  } catch (_) {}
};

const recordModelSuccess = (model: string, durationMs: number) => {
  const table = getModelBenchmarks();
  const existing = table[model];
  const newSuccessCount = (existing?.successCount || 0) + 1;
  const newAvg = existing?.avgResponseTimeMs
    ? Math.round((existing.avgResponseTimeMs * existing.successCount + durationMs) / newSuccessCount)
    : durationMs;

  table[model] = {
    model,
    status: 'healthy',
    lastResponseTimeMs: durationMs,
    avgResponseTimeMs: newAvg,
    successCount: newSuccessCount,
    errorCount: 0,
    lastSuccessTimestamp: Date.now(),
    lastErrorMessage: undefined
  };
  saveModelBenchmarks(table);
  try {
    localStorage.setItem('nexus_last_working_ai_model', model);
  } catch (_) {}
};

const recordModelError = (model: string, errorMsg: string, durationMs: number = 0) => {
  const table = getModelBenchmarks();
  const existing = table[model];
  table[model] = {
    model,
    status: 'error',
    lastResponseTimeMs: durationMs || existing?.lastResponseTimeMs || 999999,
    avgResponseTimeMs: existing?.avgResponseTimeMs || 999999,
    successCount: existing?.successCount || 0,
    errorCount: (existing?.errorCount || 0) + 1,
    lastErrorTimestamp: Date.now(),
    lastErrorMessage: errorMsg
  };
  saveModelBenchmarks(table);
};

const Mermaid = React.memo(({ chart }: { chart: string }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState('');

  useEffect(() => {
    if (ref.current && chart) {
      mermaid.render(`mermaid-${Math.random().toString(36).substr(2, 9)}`, chart).then(result => {
        setSvg(result.svg);
      }).catch(err => {
        console.error('Mermaid Render Error:', err);
        const isFetchError = err.message?.toLowerCase().includes('failed to fetch') || err.message?.toLowerCase().includes('dynamically imported module');
        if (isFetchError) {
          setSvg(`
            <div style="padding: 12px; border: 1px dashed #ef4444; border-radius: 8px; background: #fef2f2; font-size: 11px; color: #991b1b;">
              <p><strong>System Update Detected:</strong> Build assets have shifted.</p>
              <p style="margin-top: 4px;">Please <strong>Hard Refresh (Ctrl + F5)</strong> your browser to recalibrate the intelligence engine.</p>
            </div>
          `);
        } else {
          setSvg(`<p style="color:red; font-size:10px;">Failed to render chart: ${err.message}</p>`);
        }
      });
    }
  }, [chart]);

  return <div ref={ref} dangerouslySetInnerHTML={{ __html: svg }} className="my-4 overflow-x-auto" />;
});

export const AIAssistant: React.FC<AIAssistantProps> = ({ orders, config, currentUser }) => {
  const isSandbox = Boolean(currentUser?.sandbox);
  const sandboxOwner = currentUser?.sandboxOwner || currentUser?.username || 'live';
  const environmentName = isSandbox
    ? (currentUser?.sandboxLabel || `${sandboxOwner}'s Sandbox`)
    : 'Live ERP (Production)';
  const activeUserName = currentUser?.name || currentUser?.username || 'Authorized Analyst';
  const activeUserRoles = currentUser?.roles?.join(', ') || 'management';

  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<{ role: 'user' | 'ai', content: string }[]>([
    {
      role: 'ai',
      content: isSandbox
        ? `🧪 **Sandbox Strategic Intelligence Engine** initialized for **${environmentName}** (User: **${activeUserName}**).\n\nI have digested your isolated sandbox dataset, order pipelines, component sourcing, and ERP simulation workflows. Ask me about your test orders, simulations, financial metrics, or next workflow actions!`
        : `⚡ **Strategic Intelligence Engine** initialized for **Live ERP (Production)**.\n\nI have indexed your entire order history, financial metrics, component pipelines, and delivery timelines. Ask me about specific values, largest orders, monthly performance, or operational workflows.`
    }
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const [activeModelName, setActiveModelName] = useState<string>('');
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const chartConfig = config?.settings?.chartConfig || {} as any;
      const themeName = chartConfig.theme || 'neutral';

      const primaryColor = chartConfig.primaryColor || '#6366f1';
      const backgroundColor = chartConfig.backgroundColor || '#ffffff';
      const textColor = chartConfig.textColor || (themeName === 'dark' ? '#f8fafc' : '#1e293b');

      const validThemes = ['neutral', 'base', 'forest', 'dark'];
      const safeTheme = validThemes.includes(themeName) ? themeName : 'neutral';

      const themeVariables = {
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: '14px',
        primaryColor: primaryColor,
        primaryTextColor: textColor,
        primaryBorderColor: primaryColor,
        lineColor: safeTheme === 'dark' ? '#94a3b8' : '#64748b',
        secondaryColor: safeTheme === 'dark' ? '#1e293b' : '#f0fdf4',
        tertiaryColor: safeTheme === 'dark' ? '#334155' : '#fef2f2',
        mainBkg: backgroundColor,
        nodeBorder: primaryColor,
        clusterBkg: backgroundColor,
        titleColor: textColor,
        edgeLabelBackground: backgroundColor,
        actorBkg: backgroundColor,
        actorBorder: primaryColor,
        actorTextColor: textColor,
        signalTextColor: textColor,
        noteBkg: backgroundColor,
        noteTextColor: textColor,
      };

      mermaid.initialize({
        startOnLoad: true,
        theme: safeTheme,
        securityLevel: 'loose',
        themeVariables: themeVariables
      });
    } catch (err) {
      console.error("Failed to initialize chart engine:", err);
      try {
        mermaid.initialize({ startOnLoad: true, theme: 'neutral' });
      } catch (e) {
        console.error("Critical: Mermaid failed to initialize even with defaults", e);
      }
    }
  }, [config?.settings?.chartConfig]);

  // Compress the order ledger and workflow state for AI consumption
  const orderLedgerSummary = useMemo(() => {
    return orders.map(o => {
      const valueExclTax = o.items.reduce((sum, item) => sum + (getItemEffectiveQty(item) * item.pricePerUnit), 0);
      return {
        id: o.internalOrderNumber,
        po: o.customerReferenceNumber || 'N/A',
        customer: o.customerName,
        project: o.projectName || 'Non-Project',
        isBlanketOrder: Boolean(o.blanketOrder),
        contractId: o.contractId || o.blanketContractId || null,
        status: o.status,
        date: o.orderDate || o.dataEntryTimestamp,
        value: valueExclTax,
        currency: o.currency || 'L.E.',
        isNegativeMargin: o.status === OrderStatus.NEGATIVE_MARGIN,
        loggingDelayViolation: Boolean(o.loggingComplianceViolation),
        itemCount: o.items.length,
        items: o.items.map(i => ({
          orderNumber: i.orderNumber,
          description: i.description,
          productionType: i.productionType,
          quantity: i.quantity,
          mfgQty: i.manufacturedQty || 0,
          hubQty: i.hubReceivedQty || 0,
          pendingShip: Math.max(0, (i.approvedForDispatchQty || 0) - (i.dispatchedQty || 0)),
          inTransit: Math.max(0, (i.shippedQty || 0) - (i.deliveredQty || 0)),
          delivered: i.deliveredQty || 0,
          components: (i.components || []).map(c => ({
            number: c.componentNumber || 'TBD',
            description: c.description,
            source: c.source,
            status: c.status,
            quantity: c.quantity,
            unit: c.unit,
            supplier: c.supplierName,
            poNumber: c.poNumber,
            unitCost: c.unitCost,
            contractNumber: c.contractNumber,
            contractStartDate: c.contractStartDate,
            contractDuration: c.contractDuration
          }))
        })),
        recentLogs: (o.logs || []).slice(-5).map(l => `[${l.timestamp?.split('T')[1]?.slice(0, 5) || ''}] ${l.message}`)
      };
    });
  }, [orders]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  const runStrategicInference = async (systemContext: string, query: string): Promise<string> => {
    if (config.settings.aiProvider === 'gemini') {
      const apiKey = config.settings.geminiConfig?.apiKey;
      const modelName = config.settings.geminiConfig?.modelName || 'gemini-1.5-flash';

      if (!apiKey) {
        throw new Error("Gemini API Key is not configured. Please check Settings > AI Configuration.");
      }

      setActiveModelName(modelName);
      const ai = new GoogleGenAI({ apiKey });
      const response = await ai.models.generateContent({
        model: modelName,
        contents: `${systemContext}\n\nUSER QUERY: ${query}`
      });
      if (!response.text || !response.text.trim()) {
        throw new Error("Gemini returned an empty response.");
      }
      return response.text;
    }

    const { apiKey, baseUrl, modelName } = config.settings.openaiConfig || {};
    if (!apiKey) {
      throw new Error("AI API Key is not configured. Please add your API key in Settings > AI Configuration.");
    }
    const upstreamEndpoint = `${(baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '')}/chat/completions`;
    const isRouter = (baseUrl || '').includes('openrouter.ai');

    const knownModels = [
      'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
      'dots-studio/dots-3-note-preview:free',
      'google/gemma-4-26b-a4b-it:free',
      'minimax/minimax-m3:free',
      'openrouter/auto'
    ];
    if (modelName && !knownModels.includes(modelName)) {
      knownModels.unshift(modelName);
    }

    // Retrieve persistent benchmark metrics table (matching OrderManagement OCR engine)
    const benchmarkTable = getModelBenchmarks();

    const healthyModels = knownModels
      .filter(m => benchmarkTable[m]?.status === 'healthy')
      .sort((a, b) => (benchmarkTable[a]?.avgResponseTimeMs || 9999) - (benchmarkTable[b]?.avgResponseTimeMs || 9999));

    const untestedModels = knownModels.filter(m => !benchmarkTable[m]);

    const erroredModels = knownModels
      .filter(m => benchmarkTable[m]?.status === 'error')
      .sort((a, b) => (benchmarkTable[a]?.lastErrorTimestamp || 0) - (benchmarkTable[b]?.lastErrorTimestamp || 0));

    const orderedCandidates = isRouter
      ? Array.from(new Set([...healthyModels, ...untestedModels, ...erroredModels]))
      : [modelName || 'gpt-4o'];

    const executionLog: Array<{ model: string; status: 'ok' | 'error'; durationMs: number; errorMsg?: string }> = [];

    for (const currentModel of orderedCandidates) {
      const modelStart = performance.now();
      try {
        const shortName = currentModel.split('/')[1]?.split(':')[0] || currentModel;
        setActiveModelName(shortName);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000); // 25s per-model timeout

        const response = await fetch('/api/v1/ai-proxy/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          body: JSON.stringify({
            endpoint: upstreamEndpoint,
            apiKey,
            payload: {
              model: currentModel,
              max_tokens: 4096,
              temperature: 0.2,
              messages: [
                { role: 'system', content: systemContext },
                { role: 'user', content: query }
              ]
            }
          })
        });

        clearTimeout(timeoutId);
        const duration = Math.round(performance.now() - modelStart);

        if (!response.ok) {
          const errJson = await response.json().catch(() => ({}));
          const errMessage = errJson?.error?.message || errJson?.error || `HTTP ${response.status}: ${response.statusText}`;
          recordModelError(currentModel, errMessage, duration);
          executionLog.push({ model: currentModel, status: 'error', durationMs: duration, errorMsg: errMessage });
          continue; // Fallback to next candidate model in queue
        }

        const data = await response.json();
        const rawText = data?.choices?.[0]?.message?.content || '';
        if (!rawText.trim()) {
          const emptyMsg = 'Model returned empty completion.';
          recordModelError(currentModel, emptyMsg, duration);
          executionLog.push({ model: currentModel, status: 'error', durationMs: duration, errorMsg: emptyMsg });
          continue;
        }

        recordModelSuccess(currentModel, duration);
        return rawText;
      } catch (err: any) {
        const duration = Math.round(performance.now() - modelStart);
        const isAbort = err.name === 'AbortError';
        const msg = isAbort ? 'Request timed out after 25s' : (err.message || 'Network connectivity fault');
        recordModelError(currentModel, msg, duration);
        executionLog.push({ model: currentModel, status: 'error', durationMs: duration, errorMsg: msg });
        continue;
      }
    }

    const failures = executionLog.map(e => `• ${e.model}: ${e.errorMsg || 'Failed'} (${e.durationMs}ms)`).join('\n');
    throw new Error(`All candidate AI models failed:\n${failures}`);
  };

  const handleSend = async () => {
    if (!input.trim() || isTyping) return;

    const userMsg = input;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setIsTyping(true);

    try {
      const currentDate = new Date().toISOString().split('T')[0];

      const context = `
        ROLE: You are the Nexus ERP Strategic Assistant & Operational Intelligence Analyst.
        SYSTEM DATE: ${currentDate}
        
        ENVIRONMENT CONTEXT:
        - Mode: ${isSandbox ? 'SANDBOX ISOLATED SIMULATION' : 'LIVE PRODUCTION ERP'}
        - Environment Name: ${environmentName}
        - Sandbox Owner: ${sandboxOwner}
        - Active User: ${activeUserName} (Roles: ${activeUserRoles})
        ${isSandbox ? '- NOTE: The data below represents this specific Sandbox environment. You should provide insights tailored to this sandbox testing session, explain test workflows, and guide simulation steps.' : '- NOTE: The data below represents live company operations.'}

        DATA SCOPE:
        You have direct access to the entire order ledger for this environment, including customer PO references, project associations, bill-of-materials components, supplier pricing, manufacturing stages, stock hub positions, dispatch statuses, and audit logs.
        
        LEDGER DATA (JSON): 
        ${JSON.stringify(orderLedgerSummary)}

        NEXUS ERP 8-STAGE OPERATIONAL WORKFLOW BLUEPRINT:
        1. ORDER MANAGEMENT & LOGGING:
           - Customer orders entered via Standard or Blanket order views.
           - PO references captured and validated. Logging delay compliance checked.
           - Orders with 'blanketOrder: true' are strict Blanket Orders.
        2. TECHNICAL REVIEW & BOM:
           - Decomposition into component line items.
           - Sourcing determined per component: 'PROCUREMENT' (buy), 'STOCK_INVENTORY' (warehouse), 'OUTSOURCING' (third-party services).
           - Component internal part numbers auto-generated.
        3. PROCUREMENT & SOURCING:
           - RFP quote generation for required components.
           - Commercial bid selection and awarding to suppliers.
           - Multi-component Purchase Order ('PO') batching & generation.
           - Outsourcing contract tracking (duration, start dates, and replacements).
        4. FACTORY & MANUFACTURING:
           - Work orders routed through manufacturing steps ('WAITING_FACTORY' -> 'MANUFACTURING' -> 'MANUFACTURED').
           - Production receipts and quality clearance.
        5. STOCK RECEPTION & PRODUCT HUB:
           - Physical delivery intake into warehouse hub ('TRANSITION_TO_STOCK' -> 'IN_PRODUCT_HUB').
           - Reserved component staging for assembly.
        6. SHIPMENT & LOGISTICS:
           - Dispatch approval ('WAITING_DISPATCH' -> 'DISPATCHED').
           - Waybill generation, driver assignment, in-transit delivery tracking to client ('DELIVERED').
        7. FINANCE & BILLING:
           - Customer invoicing, tax calculations (14% VAT), and payment collection.
           - Automatic negative margin detection & margin protection alerts.
        8. SANDBOX EXPERIMENTATION & TRAINING:
           - Isolated sandbox databases ('db.sandbox.<owner>.json').
           - 'Revert to Login State' restores the database back to the snapshot at logon for repeatable practice scenarios.
           - 'Reset Data' re-seeds fresh baseline datasets.

        ANALYST GUIDELINES:
        1. BE ACCURATE, CONCISE, AND ACTIONABLE. Provide direct numbers and clean breakdowns.
        2. FORMATTING:
           - Single Order: **Order No.** [ID], **PO Ref** [PO], **Customer** [Name], **Project** [Project Name / Non-Project], **Value** [Amount] [Currency], **Status**: [Status].
           - Detailed items: Bullet points showing **MFG**, **HUB**, **TRANSIT**, and **DELIVERED** quantities.
           - Comparisons & Multi-order Summaries: ALWAYS format as clean Markdown Tables with a blank line before and after.
        3. FINANCIAL & BOTTLENECK ANALYSIS:
           - Highlight delayed orders, negative margins, or components awaiting RFP/PO.
        4. CHARTS & MERMAID DIAGRAMS:
           - You SUPPORT dynamic chart and diagram rendering using Mermaid.js.
           - When asked for a diagram, flowchart, pipeline, or chart, provide a valid Mermaid code block starting with \`\`\`mermaid.
           - Supported types: Flowcharts (graph TD / graph LR), Pie Charts (pie), Gantt Charts (gantt), Sequence Diagrams (sequenceDiagram).
           - Keep Mermaid styling clean, neutral, and without HTML tags.
      `;

      const responseText = await runStrategicInference(context, userMsg);
      setMessages(prev => [...prev, { role: 'ai', content: responseText }]);
    } catch (error: any) {
      console.error("AI Assistant Fault:", error);
      setMessages(prev => [...prev, { role: 'ai', content: `### Intelligence Engine Notice\n${error.message || 'Check system AI configuration in Settings.'}` }]);
    } finally {
      setIsTyping(false);
      setActiveModelName('');
    }
  };

  const markdownComponents = useMemo(() => ({
    code({ node, inline, className, children, ...props }: any) {
      const match = /language-(\w+)/.exec(className || '');
      if (!inline && match && match[1] === 'mermaid') {
        return <Mermaid chart={String(children).replace(/\n$/, '')} />;
      }
      return !inline && match ? (
        <div className="mockup-code">
          <code className={className} {...props}>
            {children}
          </code>
        </div>
      ) : (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
  }), []);

  const [position, setPosition] = useState<{ top: number, left: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const dragOffset = useRef({ x: 0, y: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isDragging) return;

    const onMouseMove = (e: MouseEvent) => {
      setPosition({
        top: e.clientY - dragOffset.current.y,
        left: e.clientX - dragOffset.current.x
      });
    };

    const onMouseUp = () => {
      setIsDragging(false);
    };

    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [isDragging]);

  const handleMouseDown = (e: React.MouseEvent) => {
    // Prevent drag if clicking the bounce dot or other future interactive elements if any
    e.stopPropagation();

    if (buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      dragOffset.current = {
        x: e.clientX - rect.left,
        y: e.clientY - rect.top
      };
      setPosition({ top: rect.top, left: rect.left });
      setIsDragging(true);
    }
  };

  return (
    <>
      <button
        ref={buttonRef}
        onMouseDown={handleMouseDown}
        onClick={(e) => {
          // Prevent click if we just dragged (simple check: if we moved significantly? 
          // Actually, standard click fires on mouseup. If we were dragging, we probably don't want to open. 
          // But for now, let's keep it simple. Usually small drags are clicks.)
          if (!isDragging) setIsOpen(true);
        }}
        style={position ? { top: position.top, left: position.left, position: 'fixed', bottom: 'auto', right: 'auto', touchAction: 'none' } : {}}
        className={`fixed z-[100] w-16 h-16 rounded-full bg-slate-900 text-white shadow-2xl transition-transform hover:scale-110 hover:bg-indigo-600 flex items-center justify-center group cursor-move ${!position ? 'bottom-8 right-8' : ''} ${isOpen ? 'opacity-0 scale-0' : 'opacity-100 scale-100'}`}
      >
        <i className="fa-solid fa-face-smile-wink text-3xl text-indigo-100"></i>
        <span className="absolute -top-1 -right-1 w-5 h-5 bg-indigo-500 rounded-full border-2 border-white animate-bounce"></span>
      </button>

      <div className={`fixed top-0 right-0 h-full w-full md:w-[600px] bg-white shadow-2xl z-[110] transition-all duration-500 transform ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="flex flex-col h-full">
          <div className="p-6 bg-slate-900 text-white flex justify-between items-center border-b border-white/10">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center shadow-lg">
                <i className="fa-solid fa-bolt-lightning text-white text-base"></i>
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="font-black uppercase tracking-widest text-sm">Strategic AI Assistant</h3>
                  {isSandbox ? (
                    <span className="px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 text-[8px] font-black uppercase border border-amber-500/30">
                      🧪 Sandbox
                    </span>
                  ) : (
                    <span className="px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 text-[8px] font-black uppercase border border-emerald-500/30">
                      ⚡ Live
                    </span>
                  )}
                </div>
                <p className="text-[9px] text-slate-400 font-bold uppercase truncate max-w-[280px]">
                  {environmentName} • {activeUserName}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {activeModelName && (
                <span className="px-2 py-1 rounded-lg bg-blue-950 text-blue-300 border border-blue-800 text-[8px] font-mono font-bold uppercase animate-pulse">
                  <i className="fa-solid fa-microchip mr-1"></i> {activeModelName}
                </span>
              )}
              <button onClick={() => setIsOpen(false)} className="w-10 h-10 rounded-full hover:bg-white/10 transition-colors flex items-center justify-center">
                <i className="fa-solid fa-xmark text-slate-300"></i>
              </button>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-6 space-y-6 bg-slate-50/50 custom-scrollbar">
            {messages.map((msg, i) => (
              <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[95%] p-5 rounded-2xl text-sm leading-relaxed ${msg.role === 'user'
                  ? 'bg-blue-600 text-white shadow-xl rounded-tr-none'
                  : 'bg-white border border-slate-200 text-slate-800 shadow-sm rounded-tl-none ai-content prose prose-sm prose-slate max-w-none overflow-x-auto'
                  }`}>
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={markdownComponents as any}
                  >
                    {msg.content}
                  </ReactMarkdown>
                </div>
              </div>
            ))}
            {isTyping && (
              <div className="flex justify-start">
                <div className="bg-white border border-slate-100 p-4 rounded-2xl flex gap-1 shadow-sm">
                  <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce"></div>
                  <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce delay-75"></div>
                  <div className="w-1.5 h-1.5 bg-slate-300 rounded-full animate-bounce delay-150"></div>
                </div>
              </div>
            )}
          </div>

          <div className="p-6 bg-white border-t border-slate-100">
            <div className="relative">
              <input
                type="text"
                placeholder={isSandbox ? "Ask about sandbox simulation data, orders, or bottlenecks..." : "Ask about orders, financial metrics, or trends..."}
                className="w-full pl-4 pr-12 py-4 bg-slate-100 border-2 border-transparent rounded-2xl outline-none focus:bg-white focus:border-blue-500 transition-all font-medium text-sm"
                value={input}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleSend()}
              />
              <button
                onClick={handleSend}
                disabled={!input.trim()}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 bg-slate-900 text-white rounded-xl flex items-center justify-center hover:bg-blue-600 disabled:opacity-30 transition-colors"
              >
                <i className="fa-solid fa-paper-plane text-xs"></i>
              </button>
            </div>
            <div className="mt-4 flex gap-2 overflow-x-auto pb-1 no-scrollbar">
              <button onClick={() => setInput('Draw a flowchart diagram for the 8-stage order lifecycle in NexusERP.')} className="whitespace-nowrap px-3 py-1.5 bg-slate-50 border rounded-lg text-[10px] font-bold text-slate-600 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 transition-all uppercase tracking-tight">Flowchart</button>
              <button onClick={() => setInput('Show a table breakdown of all orders in this environment by status and financial value.')} className="whitespace-nowrap px-3 py-1.5 bg-slate-50 border rounded-lg text-[10px] font-bold text-slate-600 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 transition-all uppercase tracking-tight">Order Status Table</button>
              <button onClick={() => setInput('Identify any orders with delayed parts, negative margins, or bottlenecks in this sandbox.')} className="whitespace-nowrap px-3 py-1.5 bg-slate-50 border rounded-lg text-[10px] font-bold text-slate-600 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 transition-all uppercase tracking-tight">Bottleneck Check</button>
              <button onClick={() => setInput('Show a pie chart of top customers by revenue.')} className="whitespace-nowrap px-3 py-1.5 bg-slate-50 border rounded-lg text-[10px] font-bold text-slate-600 hover:bg-blue-50 hover:text-blue-600 hover:border-blue-200 transition-all uppercase tracking-tight">Customer Pie Chart</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
