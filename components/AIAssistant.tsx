
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { GoogleGenAI } from "@google/genai";
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import mermaid from 'mermaid';
import { CustomerOrder, OrderStatus, AppConfig } from '../types';

interface AIAssistantProps {
  orders: CustomerOrder[];
  config: AppConfig;
}

const Mermaid = ({ chart }: { chart: string }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [svg, setSvg] = useState('');

  useEffect(() => {
    if (ref.current && chart) {
      mermaid.render(`mermaid-${Math.random().toString(36).substr(2, 9)}`, chart).then(result => {
        setSvg(result.svg);
      }).catch(err => {
        console.error('Mermaid Render Error:', err);
        setSvg(`<p style="color:red; font-size:10px;">Failed to render chart: ${err.message}</p>`);
      });
    }
  }, [chart]);

  return <div ref={ref} dangerouslySetInnerHTML={{ __html: svg }} className="my-4 overflow-x-auto" />;
};

export const AIAssistant: React.FC<AIAssistantProps> = ({ orders, config }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<{ role: 'user' | 'ai', content: string }[]>([
    { role: 'ai', content: `**Strategic Intelligence Engine** initialized. \n\nI have indexed your entire order history, financial metrics, and delivery timelines. Ask me about specific values, largest orders, or monthly performance.` }
  ]);
  const [input, setInput] = useState('');
  const [isTyping, setIsTyping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      // Default to 'neutral' if config is missing or invalid
      const chartConfig = config?.settings?.chartConfig || {};
      const themeName = chartConfig.theme || 'neutral';

      const primaryColor = chartConfig.primaryColor || '#6366f1';
      const backgroundColor = chartConfig.backgroundColor || '#ffffff';
      const textColor = chartConfig.textColor || (themeName === 'dark' ? '#f8fafc' : '#1e293b');

      // Ensure valid theme name
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
      // Fallback to safe default
      try {
        mermaid.initialize({ startOnLoad: true, theme: 'neutral' });
      } catch (e) {
        console.error("Critical: Mermaid failed to initialize even with defaults", e);
      }
    }
  }, [config?.settings?.chartConfig]);

  // Compress the order ledger for AI consumption
  const orderLedgerSummary = useMemo(() => {
    return orders.map(o => {
      const valueExclTax = o.items.reduce((sum, item) => sum + (item.quantity * item.pricePerUnit), 0);
      return {
        id: o.internalOrderNumber,
        po: o.customerReferenceNumber,
        customer: o.customerName,
        status: o.status,
        date: o.orderDate,
        value: valueExclTax,
        itemCount: o.items.length,
        items: o.items.map(i => i.description).join(', ')
      };
    });
  }, [orders]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isTyping]);

  const handleSend = async () => {
    if (!input.trim() || isTyping) return;

    const userMsg = input;
    setInput('');
    setMessages(prev => [...prev, { role: 'user', content: userMsg }]);
    setIsTyping(true);

    try {
      const currentDate = new Date().toISOString().split('T')[0];

      const context = `
        ROLE: You are the Nexus ERP Strategic Assistant. You are a precise, brief, and helpful financial analyst.
        SYSTEM DATE: ${currentDate}
        DATA SCOPE: You have access to the full order ledger provided below.
        
        LEDGER DATA (JSON): ${JSON.stringify(orderLedgerSummary)}

        GUIDELINES:
        1. BE BRIEF. If the answer is a single value or order, give it directly.
        2. FORMATTING: 
           - For single orders, use: **Order No.** [ID], **PO** [PO], **Customer** [Name], **Value** [Amount] L.E., **Details**: [Item List].
           - For multiple items or comparisons, ALWAYS use a proper Markdown Table.
           - CRITICAL: Tables MUST have a blank line before and after them to render correctly. Each row must be on a new line.
        3. CALCULATIONS: If asked for the "largest fulfilled", filter for status 'FULFILLED' and sort by 'value'.
        4. TIME SENSITIVITY: Use the SYSTEM DATE to interpret "last 3 months", "this year", etc.
        5. CHARTS & DRAWINGS:
           - You SUPPORT rendering charts using Mermaid.js.
           - If a user asks for a chart, drawing, flowchart, or graph, provide the Mermaid code block starting with \`\`\`mermaid.
           - Supported: Flowcharts (graph TD), Pie Charts (pie), Gantt Charts (gantt), Sequence Diagrams (sequenceDiagram).
           - STYLING: The system uses a 'neutral' theme. Do NOT force dark themes. Keep diagrams simple and clean.
           - Do NOT say "I cannot draw". You CAN draw using code.
      `;

      let responseText = "";

      if (config.settings.aiProvider === 'gemini') {
        const apiKey = config.settings.geminiConfig?.apiKey;
        const modelName = config.settings.geminiConfig?.modelName || 'gemini-1.5-flash';

        if (!apiKey) {
          responseText = "Configuration Error: Gemini API Key is missing. Please ask your administrator to configure it in System Control -> AI Engine.";
        } else {
          const ai = new GoogleGenAI({ apiKey });
          const response = await ai.models.generateContent({
            model: modelName,
            contents: `${context}\n\nUSER QUERY: ${userMsg}`,
          });
          responseText = response.text || "I was unable to process that query.";
        }
      } else {
        const { apiKey, baseUrl, modelName } = config.settings.openaiConfig;
        const endpoint = `${baseUrl.endsWith('/') ? baseUrl : baseUrl + '/'}chat/completions`;

        const response = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`
          },
          body: JSON.stringify({
            model: modelName,
            messages: [
              { role: 'system', content: context },
              { role: 'user', content: userMsg }
            ],
            temperature: 0.2
          })
        });

        if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);
        const data = await response.json();
        responseText = data.choices?.[0]?.message?.content || "No strategic insight returned.";
      }

      setMessages(prev => [...prev, { role: 'ai', content: responseText }]);
    } catch (error: any) {
      console.error("AI Assistant Fault:", error);
      setMessages(prev => [...prev, { role: 'ai', content: `### Connectivity Fault\nSecure Intelligence link failed. ${error.message || 'Check system API configuration.'}` }]);
    } finally {
      setIsTyping(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setIsOpen(true)}
        className={`fixed bottom-8 right-8 w-16 h-16 rounded-full bg-slate-900 text-white shadow-2xl z-[100] transition-all hover:scale-110 hover:bg-blue-600 flex items-center justify-center group ${isOpen ? 'opacity-0 scale-0' : 'opacity-100 scale-100'}`}
      >
        <i className="fa-solid fa-brain-circuit text-2xl"></i>
        <span className="absolute -top-1 -right-1 w-5 h-5 bg-blue-500 rounded-full border-2 border-white animate-bounce"></span>
      </button>

      <div className={`fixed top-0 right-0 h-full w-full md:w-[600px] bg-white shadow-2xl z-[110] transition-all duration-500 transform ${isOpen ? 'translate-x-0' : 'translate-x-full'}`}>
        <div className="flex flex-col h-full">
          <div className="p-6 bg-slate-900 text-white flex justify-between items-center">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-xl bg-blue-600 flex items-center justify-center shadow-lg">
                <i className="fa-solid fa-bolt-lightning"></i>
              </div>
              <div>
                <h3 className="font-black uppercase tracking-widest text-sm">Strategic AI Assistant</h3>
                <p className="text-[9px] text-slate-400 font-bold uppercase">Nexus Operational Intelligence</p>
              </div>
            </div>
            <button onClick={() => setIsOpen(false)} className="w-10 h-10 rounded-full hover:bg-white/10 transition-colors">
              <i className="fa-solid fa-xmark"></i>
            </button>
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
                    components={{
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
                    }}
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
                placeholder="Ask about orders, values, or trends..."
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
              <button onClick={() => setInput('Draw a flow chart diagram for a typical order cycle in NexusERP.')} className="whitespace-nowrap px-3 py-1.5 bg-slate-50 border rounded-lg text-[10px] font-bold text-slate-500 hover:bg-blue-50 hover:text-blue-600 transition-colors uppercase tracking-tight">Draw Flowchart</button>
              <button onClick={() => setInput('Show a pie chart of my top customers based on the data.')} className="whitespace-nowrap px-3 py-1.5 bg-slate-50 border rounded-lg text-[10px] font-bold text-slate-500 hover:bg-blue-50 hover:text-blue-600 transition-colors uppercase tracking-tight">Customer Pie Chart</button>
              <button onClick={() => setInput('Summarize this month revenue.')} className="whitespace-nowrap px-3 py-1.5 bg-slate-50 border rounded-lg text-[10px] font-bold text-slate-500 hover:bg-blue-50 hover:text-blue-600 transition-colors uppercase tracking-tight">Monthly revenue</button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
};
