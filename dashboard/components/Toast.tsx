"use client";

import React, { useEffect, useState, useCallback, createContext, useContext } from "react";

export interface ToastMessage {
  id: string;
  type: "success" | "error" | "info" | "warning";
  text: string;
  link?: { label: string; href: string };
}

interface ToastCtx {
  toast: (msg: Omit<ToastMessage, "id">) => void;
}

const ToastContext = createContext<ToastCtx>({ toast: () => {} });
export const useToast = () => useContext(ToastContext);

function ToastItem({ msg, onDismiss }: { msg: ToastMessage; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 6000);
    return () => clearTimeout(t);
  }, [onDismiss]);

  const colors = {
    success: "border-emerald-500/40 bg-emerald-950/60 text-emerald-200",
    error: "border-rose-500/40 bg-rose-950/60 text-rose-200",
    info: "border-blue-500/40 bg-blue-950/60 text-blue-200",
    warning: "border-amber-500/40 bg-amber-950/60 text-amber-200",
  };

  return (
    <div
      className={`flex items-start gap-3 px-4 py-3 rounded-lg border text-xs font-mono shadow-lg ${colors[msg.type]} animate-slide-in`}
    >
      <span className="flex-1">{msg.text}</span>
      {msg.link && (
        <a href={msg.link.href} target="_blank" rel="noreferrer" className="underline shrink-0">
          {msg.link.label} ↗
        </a>
      )}
      <button type="button" onClick={onDismiss} className="text-current opacity-50 hover:opacity-100">
        ✕
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [messages, setMessages] = useState<ToastMessage[]>([]);

  const toast = useCallback((msg: Omit<ToastMessage, "id">) => {
    const id = Math.random().toString(36).slice(2);
    setMessages((prev) => [...prev.slice(-4), { ...msg, id }]);
  }, []);

  const dismiss = useCallback((id: string) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 max-w-sm">
        {messages.map((m) => (
          <ToastItem key={m.id} msg={m} onDismiss={() => dismiss(m.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

