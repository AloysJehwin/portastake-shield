import type { Config } from "tailwindcss";

/**
 * Minimalist light theme with a glassmorphism layer.
 * Tokens here are referenced from `src/styles/index.css` via component classes
 * so the surface stays consistent across pages.
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: "#FFFFFF",
        surface: "#FAFAFA",
        // used with backdrop-blur: see .card-glass in index.css
        glass: "rgba(255,255,255,0.55)",
        line: "#E5E5E5",
        "line-strong": "#D4D4D4",
        fg: "#0A0A0A",
        "fg-muted": "#6B6B6B",
        "fg-subtle": "#A3A3A3",
        accent: "#2563EB",
        success: "#10B981",
        danger: "#DC2626",
      },
      fontFamily: {
        sans: [
          '"Inter Variable"',
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "sans-serif",
        ],
        mono: [
          '"JetBrains Mono"',
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      fontSize: {
        xs: ["12px", { lineHeight: "1.5" }],
        sm: ["14px", { lineHeight: "1.5" }],
        base: ["16px", { lineHeight: "1.5" }],
        lg: ["20px", { lineHeight: "1.4" }],
        xl: ["28px", { lineHeight: "1.2" }],
        "2xl": ["40px", { lineHeight: "1.1" }],
      },
      borderRadius: {
        sm: "8px",
        DEFAULT: "10px",
        md: "12px",
        lg: "16px",
        full: "9999px",
      },
      maxWidth: {
        content: "1120px",
        mobile: "480px",
      },
      transitionProperty: {
        backdrop: "backdrop-filter",
      },
    },
  },
  plugins: [],
} satisfies Config;
