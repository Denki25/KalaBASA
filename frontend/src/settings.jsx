import { createContext, useContext, useEffect, useMemo, useState } from "react";

const SettingsContext = createContext(null);
const AI_AUTO_CHECK_KEY = "kalabasa.aiAutoCheck";

function readAiAutoCheck() {
  try {
    return window.localStorage.getItem(AI_AUTO_CHECK_KEY) !== "false";
  } catch {
    return true;
  }
}

export function SettingsProvider({ children }) {
  const [aiAutoCheck, setAiAutoCheck] = useState(readAiAutoCheck);

  useEffect(() => {
    try {
      window.localStorage.setItem(AI_AUTO_CHECK_KEY, String(aiAutoCheck));
    } catch {
      // Keep the current tab setting if browser storage is unavailable.
    }
  }, [aiAutoCheck]);

  useEffect(() => {
    function syncSetting(event) {
      if (event.key === AI_AUTO_CHECK_KEY) setAiAutoCheck(event.newValue !== "false");
    }
    window.addEventListener("storage", syncSetting);
    return () => window.removeEventListener("storage", syncSetting);
  }, []);

  const value = useMemo(() => ({ aiAutoCheck, setAiAutoCheck }), [aiAutoCheck]);
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings() {
  const settings = useContext(SettingsContext);
  if (!settings) throw new Error("useSettings must be used within SettingsProvider.");
  return settings;
}
