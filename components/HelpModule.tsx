import React, { useState, useMemo } from 'react';
import { AppConfig, HelpLink, User } from '../types';

interface HelpModuleProps {
  config: AppConfig;
  currentUser: User;
}

export const HelpModule: React.FC<HelpModuleProps> = ({ config, currentUser }) => {
  const [searchTerm, setSearchTerm] = useState('');

  const helpLinks: HelpLink[] = config.settings.helpLinks || [];
  const helpVideos: string[] = config.settings.helpVideos || [];

  const filteredLinks = useMemo(() => {
    if (!searchTerm.trim()) return helpLinks;
    const q = searchTerm.toLowerCase();
    return helpLinks.filter(link =>
      link.description.toLowerCase().includes(q) ||
      link.url.toLowerCase().includes(q)
    );
  }, [helpLinks, searchTerm]);

  const filteredVideos = useMemo(() => {
    if (!searchTerm.trim()) return helpVideos;
    const q = searchTerm.toLowerCase();
    return helpVideos.filter(url => url.toLowerCase().includes(q));
  }, [helpVideos, searchTerm]);

  const hasAnyResults = filteredLinks.length > 0 || filteredVideos.length > 0;
  const totalItems = helpLinks.length + helpVideos.length;

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-black text-slate-800 uppercase tracking-tight">Help & Resources</h2>
          <p className="text-sm text-slate-500 font-medium">Quick access to guides, documentation, and support resources.</p>
        </div>
        <div className="px-4 py-2 bg-blue-50 rounded-xl border border-blue-100 text-[10px] font-black uppercase text-blue-600 tracking-widest">
          <i className="fa-solid fa-circle-info mr-2"></i>
          {currentUser.name}
        </div>
      </div>

      {/* Search Bar */}
      <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm p-6">
        <div className="relative max-w-xl">
          <div className="absolute left-5 top-1/2 -translate-y-1/2 text-slate-400">
            <i className="fa-solid fa-magnifying-glass"></i>
          </div>
          <input
            type="text"
            placeholder="Search help resources..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="w-full pl-12 pr-5 py-4 bg-slate-50 border-2 border-slate-100 rounded-2xl text-sm font-bold text-slate-700 outline-none focus:border-blue-500 focus:bg-white transition-all placeholder:text-slate-400 placeholder:font-medium"
          />
          {searchTerm && (
            <button
              onClick={() => setSearchTerm('')}
              className="absolute right-4 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center text-slate-400 hover:text-slate-600 transition-colors"
            >
              <i className="fa-solid fa-times text-xs"></i>
            </button>
          )}
        </div>
        {searchTerm && (
          <div className="mt-3 flex items-center gap-2 text-[10px] text-slate-400 font-bold">
            <i className="fa-solid fa-filter"></i>
            <span>Showing {filteredLinks.length + filteredVideos.length} of {totalItems} results</span>
          </div>
        )}
      </div>

      {/* Help Links Section */}
      <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm p-8">
        <div className="flex items-center gap-3 border-b border-slate-100 pb-4 mb-6">
          <i className="fa-solid fa-book-open text-blue-500"></i>
          <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Quick Reference Links</h3>
        </div>

        {helpLinks.length === 0 && !searchTerm ? (
          <div className="text-center py-12">
            <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <i className="fa-solid fa-link-slash text-slate-300 text-2xl"></i>
            </div>
            <p className="text-sm font-bold text-slate-400">No help links configured yet.</p>
            <p className="text-xs text-slate-400 mt-1">Contact your administrator to add helpful resources.</p>
          </div>
        ) : filteredLinks.length === 0 && searchTerm ? (
          <div className="text-center py-12">
            <div className="w-16 h-16 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-4">
              <i className="fa-solid fa-magnifying-glass text-slate-300 text-2xl"></i>
            </div>
            <p className="text-sm font-bold text-slate-400">No results found for "{searchTerm}"</p>
            <p className="text-xs text-slate-400 mt-1">Try searching with different keywords.</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {filteredLinks.map((link, idx) => (
              <a
                key={idx}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="group p-6 bg-slate-50 rounded-2xl border border-slate-100 hover:border-blue-400 hover:bg-blue-50/50 transition-all cursor-pointer"
              >
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-xl bg-blue-600 text-white flex items-center justify-center text-sm shrink-0 shadow-lg shadow-blue-200 group-hover:scale-110 transition-transform">
                    <i className="fa-solid fa-arrow-up-right-from-square"></i>
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="text-sm font-black text-slate-700 uppercase tracking-tight truncate group-hover:text-blue-700 transition-colors">
                      {link.description}
                    </h4>
                    <p className="text-[10px] text-slate-400 font-medium mt-1 truncate group-hover:text-blue-500 transition-colors">
                      {link.url}
                    </p>
                  </div>
                </div>
              </a>
            ))}
          </div>
        )}
      </div>

      {/* Video Guides Section */}
      {(filteredVideos.length > 0 || (searchTerm && helpVideos.length > 0)) && (
        <div className="bg-white rounded-[2.5rem] border border-slate-200 shadow-sm p-8">
          <div className="flex items-center gap-3 border-b border-slate-100 pb-4 mb-6">
            <i className="fa-brands fa-youtube text-red-500"></i>
            <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Video Guides</h3>
          </div>

          {filteredVideos.length === 0 && searchTerm ? (
            <div className="text-center py-8">
              <div className="w-12 h-12 bg-slate-50 rounded-full flex items-center justify-center mx-auto mb-3">
                <i className="fa-solid fa-magnifying-glass text-slate-300 text-lg"></i>
              </div>
              <p className="text-sm font-bold text-slate-400">No video results for "{searchTerm}"</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredVideos.map((url, idx) => (
              <a
                key={idx}
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="group p-6 bg-slate-50 rounded-2xl border border-slate-100 hover:border-red-400 hover:bg-red-50/30 transition-all cursor-pointer"
              >
                <div className="flex items-start gap-4">
                  <div className="w-10 h-10 rounded-xl bg-red-600 text-white flex items-center justify-center text-sm shrink-0 shadow-lg shadow-red-200 group-hover:scale-110 transition-transform">
                    <i className="fa-brands fa-youtube"></i>
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="text-sm font-black text-slate-700 uppercase tracking-tight truncate group-hover:text-red-700 transition-colors">
                      Video Tutorial {idx + 1}
                    </h4>
                    <p className="text-[10px] text-slate-400 font-medium mt-1 truncate group-hover:text-red-500 transition-colors">
                      {url}
                    </p>
                  </div>
                </div>
              </a>
            ))}
          </div>
        )}
        </div>
      )}

      {/* Contact Support Section */}
      <div className="bg-slate-50 rounded-[2.5rem] border border-slate-200 p-8">
        <div className="flex items-center gap-3 border-b border-slate-200 pb-4 mb-6">
          <i className="fa-solid fa-headset text-indigo-500"></i>
          <h3 className="text-xs font-black text-slate-400 uppercase tracking-widest">Need More Help?</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-6 bg-white rounded-2xl border border-slate-200 shadow-sm">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-indigo-100 text-indigo-600 flex items-center justify-center text-xl">
                <i className="fa-solid fa-envelope"></i>
              </div>
              <div>
                <h4 className="text-sm font-black text-slate-700 uppercase tracking-tight">Email Support</h4>
                <p className="text-xs text-slate-500 mt-1">Reach out to our technical team for assistance.</p>
              </div>
            </div>
          </div>
          <div className="p-6 bg-white rounded-2xl border border-slate-200 shadow-sm">
            <div className="flex items-center gap-4">
              <div className="w-12 h-12 rounded-xl bg-emerald-100 text-emerald-600 flex items-center justify-center text-xl">
                <i className="fa-solid fa-comments"></i>
              </div>
              <div>
                <h4 className="text-sm font-black text-slate-700 uppercase tracking-tight">System Documentation</h4>
                <p className="text-xs text-slate-500 mt-1">Browse the full knowledge base for detailed guides.</p>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
