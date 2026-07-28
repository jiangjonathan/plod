import { SYSTEM_FONT_FAMILY } from "../themes/defaultTheme";

export const SETTINGS_CSS = `
      .plot-settings-btn {
        position: absolute;
        top: 6px;
        right: 6px;
        width: 28px;
        height: 28px;
        background: transparent;
        border: none !important;
        border-radius: 50% !important;
        outline: none !important;
        box-shadow: none !important;
        color: #000000;
        font-size: 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        opacity: 0;
        transition: opacity 0.1s ease, background-color 0.1s ease, color 0.1s ease;
        z-index: 1000;
        padding: 0;
        line-height: 1;
        -webkit-user-select: none;
        user-select: none;
      }
      .plot-replay-btn,
      .plot-stream-btn {
        position: absolute;
        top: 36px;
        right: 6px;
        width: 28px;
        height: 28px;
        background: transparent;
        border: none !important;
        border-radius: 50% !important;
        outline: none !important;
        box-shadow: none !important;
        color: #000000;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        padding: 0;
        transition: opacity 0.1s ease, background-color 0.1s ease, color 0.1s ease;
        z-index: 1000;
        -webkit-user-select: none;
        user-select: none;
      }
      .plot-stream-btn {
        top: 66px;
        display: none;
      }
      .plot-replay-btn,
      .plot-stream-btn {
        font-family: ${SYSTEM_FONT_FAMILY};
        font-size: 16px;
        line-height: 1;
      }
      .plot-replay-btn svg,
      .plot-stream-btn svg {
        width: 24px;
        height: 24px;
        display: block;
        color: currentColor;
        pointer-events: none;
      }
      .plot-settings-btn,
      .plot-replay-btn,
      .plot-stream-btn,
      .plot-settings-section-title,
      .plot-settings-menu-btn,
      .plot-settings-row label,
      .plot-settings-format-btn,
      .plot-settings-btn-action,
      .plot-settings-btn-secondary {
        -webkit-user-select: none;
        user-select: none;
      }
      .plot-settings-btn:hover {
        background: rgba(0, 0, 0, 0.08) !important;
        color: #000000;
      }
      .plot-settings-btn svg {
        display: block;
        width: 20px;
        height: 20px;
        color: currentColor;
        pointer-events: none;
      }
      .plot-replay-btn:hover,
      .plot-stream-btn:hover {
        background: rgba(0, 0, 0, 0.08) !important;
        color: #000000;
      }
      .plot-settings-btn:focus,
      .plot-settings-btn:focus-visible,
      .plot-settings-btn:active,
      .plot-replay-btn:focus,
      .plot-replay-btn:focus-visible,
      .plot-replay-btn:active,
      .plot-stream-btn:focus,
      .plot-stream-btn:focus-visible,
      .plot-stream-btn:active {
        outline: none !important;
        border: none !important;
        box-shadow: none !important;
      }
      .plot-container-hovered .plot-settings-btn,
      .plot-settings-btn.active {
        opacity: 1;
      }
      .plot-container-hovered .plot-replay-btn,
      .plot-container-hovered .plot-stream-btn {
        opacity: 1;
      }
      .plot-settings-btn.active {
        background: rgba(0, 0, 0, 0.08) !important;
      }
      .plot-fullscreen-target {
        position: relative !important;
        width: 100vw !important;
        max-width: none !important;
        height: 100vh !important;
        min-height: 100vh !important;
        aspect-ratio: auto !important;
        background: #ffffff !important;
        border-radius: 0 !important;
        overflow: hidden !important;
        box-sizing: border-box !important;
      }
      .plot-fullscreen-target > .chart-instance,
      .plot-fullscreen-target > .tile-chart-instance,
      .plot-fullscreen-target > .hero-chart-container,
      .plot-fullscreen-target > .plot-container,
      .plot-fullscreen-target > div:first-child {
        width: 100% !important;
        max-width: none !important;
        height: 100% !important;
        min-height: 100% !important;
        aspect-ratio: auto !important;
      }
      .plot-fullscreen-target .plot-settings-btn {
        opacity: 1;
        top: 12px !important;
        right: 12px !important;
        color: #000000 !important;
        z-index: 1003;
      }
      .plot-fullscreen-target .plot-settings-popover {
        top: 44px !important;
        right: 14px !important;
        max-height: calc(100vh - 58px);
        z-index: 1004;
      }
      .plot-fullscreen-target .plot-settings-safety-padding {
        top: 6px !important;
        right: 14px !important;
        z-index: 1003;
      }
      .plot-fullscreen-target .plot-replay-btn,
      .plot-fullscreen-target .plot-stream-btn {
        opacity: 1;
        right: 12px !important;
        color: #000000 !important;
        z-index: 1003;
      }
      .plot-fullscreen-target .plot-replay-btn {
        top: 46px !important;
      }
      .plot-fullscreen-target .plot-stream-btn {
        top: 80px !important;
      }
      .plot-settings-popover {
        position: absolute;
        top: 38px;
        right: 8px;
        width: 220px;
        max-height: calc(100% - 50px);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        background: #ffffff;
        border: 1px solid #eef2f7;
        border-radius: 12px;
        box-shadow: 0 10px 16px -14px rgba(15, 23, 42, 0.32);
        color: #0f172a;
        font-family: ${SYSTEM_FONT_FAMILY};
        font-size: 11px;
        line-height: 1.25;
        z-index: 1001;
        opacity: 0;
        transform: translateY(-4px);
        pointer-events: none;
        padding: 6px 0;
        box-sizing: border-box;
      }
      .plot-settings-panel {
        padding: 0 2px 0 6px;
        box-sizing: border-box;
      }
      .plot-settings-panel:not([data-panel="root"]) .plot-settings-actions:first-child {
        margin-top: 0;
      }
      .plot-settings-content {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: scroll;
        margin: 0;
        padding: 0;
        box-sizing: border-box;
        overscroll-behavior: none;
        overscroll-behavior-y: none;
        -webkit-overflow-scrolling: auto;
      }
      .plot-settings-content::-webkit-scrollbar {
        width: 4px;
      }
      .plot-settings-content::-webkit-scrollbar-track {
        background: transparent;
      }
      .plot-settings-content::-webkit-scrollbar-thumb {
        background: #cbd5e1;
        border-radius: 2px;
      }
      .plot-settings-content::-webkit-scrollbar-thumb:hover {
        background: #94a3b8;
      }
      .plot-settings-popover.show {
        opacity: 1;
        transform: translateY(0);
        pointer-events: auto;
        transition: opacity 0.1s ease, transform 0.1s ease;
      }
      .plot-settings-safety-padding {
        position: absolute;
        width: 220px;
        height: 38px;
        background: transparent;
        z-index: 999;
        pointer-events: none;
      }
      .plot-settings-popover.show ~ .plot-settings-safety-padding {
        pointer-events: auto;
      }
      .plot-settings-popover h4 {
        display: none;
      }
      .plot-settings-section {
        margin-bottom: 0;
        padding-bottom: 0;
        display: block;
      }
      .plot-settings-section-title {
        font-weight: 400;
        font-size: 11px;
        color: #0f172a;
        padding: 4px 6px;
        cursor: pointer;
        display: flex;
        justify-content: space-between;
        align-items: center;
        list-style: none;
        user-select: none;
        outline: none;
        background: transparent;
        transition: background-color 0.1s ease;
        border-radius: 8px;
      }
      .plot-settings-section-title:hover {
        background: #eef2f7;
      }
      .plot-settings-section-title::-webkit-details-marker {
        display: none;
      }
      .plot-settings-section-title::after {
        content: "";
        display: inline-block;
        width: 0;
        height: 0;
        border-left: 3px solid transparent;
        border-right: 3px solid transparent;
        border-bottom: 5px solid #94a3b8;
        margin-right: 4px;
        transition: none;
      }
      .plot-settings-section[open] .plot-settings-section-title::after {
        transform: rotate(180deg);
      }
      .plot-settings-section-content {
        padding: 4px 4px 4px 6px;
      }
      .plot-settings-panel[hidden] {
        display: none;
      }
      .plot-settings-menu {
        display: flex;
        flex-direction: column;
        gap: 0;
      }
      .plot-settings-menu-btn {
        background: transparent;
        border: 1px solid transparent;
        border-radius: 8px;
        color: #0f172a;
        cursor: pointer;
        display: block;
        font-size: 11px;
        font-weight: 400;
        line-height: 1.2;
        padding: 4px 6px;
        text-align: left;
        transition: background-color 0.1s, border-color 0.1s, color 0.1s;
        width: 100%;
      }
      .plot-settings-menu-btn:hover {
        background: #eef2f7;
        border-color: transparent;
      }
      .plot-settings-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        min-height: 22px;
        margin-bottom: 3px;
        gap: 10px;
        padding-left: 6px;
        padding-right: 6px;
      }
      .plot-settings-row label {
        flex: 1;
        color: #334155;
        font-size: 11px;
        line-height: 1.2;
      }
      .plot-settings-popover input[type="text"],
      .plot-settings-popover input[type="number"],
      .plot-settings-popover select {
        background: #ffffff;
        border: 1px solid #eef2f7;
        border-radius: 6px;
        color: #0f172a;
        padding: 2px 6px;
        font-size: 11px;
        line-height: 1.2;
        outline: none;
        box-sizing: border-box;
        width: 88px;
        min-height: 24px;
        transition: border-color 0.1s, box-shadow 0.1s;
      }
      .plot-settings-popover input[type="text"]:focus,
      .plot-settings-popover input[type="number"]:focus,
      .plot-settings-popover select:focus {
        border-color: #cbd5e1;
        box-shadow: 0 0 0 3px rgba(15, 23, 42, 0.05);
      }
      .plot-settings-popover input[type="checkbox"] {
        accent-color: #0f172a;
        cursor: pointer;
        width: 13px;
        height: 13px;
        margin: 0;
        outline: none;
      }
      .plot-settings-popover input[type="color"] {
        appearance: none;
        -webkit-appearance: none;
        background: transparent;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        cursor: pointer;
        height: 22px;
        padding: 0;
        width: 54px;
      }
      .plot-settings-popover input[type="color"]::-webkit-color-swatch-wrapper {
        padding: 2px;
      }
      .plot-settings-popover input[type="color"]::-webkit-color-swatch {
        border: 0;
        border-radius: 4px;
      }
      .plot-settings-popover input[type="color"]::-moz-color-swatch {
        border: 0;
        border-radius: 4px;
      }
      .plot-settings-color-presets {
        display: grid;
        grid-template-columns: repeat(6, 1fr);
        gap: 4px;
        padding: 2px 6px 4px 6px;
      }
      .plot-settings-color-presets[hidden] {
        display: none;
      }
      .plot-settings-color-preset {
        appearance: none;
        -webkit-appearance: none;
        border: 0;
        border-radius: 5px;
        cursor: pointer;
        height: 16px;
        min-width: 0;
        padding: 0;
      }
      .plot-settings-color-preset:hover,
      .plot-settings-color-preset:focus-visible {
        box-shadow: 0 0 0 2px rgba(15, 23, 42, 0.14);
        outline: none;
      }
      .plot-settings-title-options {
        display: block;
      }
      .plot-settings-title-options[hidden] {
        display: none;
      }
      .plot-settings-control-group {
        align-items: center;
        display: inline-flex;
        gap: 3px;
      }
      .plot-settings-format-btn {
        align-items: center;
        background: #ffffff;
        border: 1px solid #eef2f7;
        border-radius: 6px;
        color: #334155;
        cursor: pointer;
        display: inline-flex;
        font-size: 11px;
        height: 22px;
        justify-content: center;
        min-width: 24px;
        padding: 0 6px;
      }
      .plot-settings-format-btn:hover {
        background: #eef2f7;
      }
      .plot-settings-format-btn[aria-pressed="true"] {
        background: #0f172a;
        border-color: #0f172a;
        color: #ffffff;
      }
      .plot-settings-format-bold {
        font-weight: 700;
      }
      .plot-settings-format-italic {
        font-style: italic;
      }
      .plot-settings-hidden-control {
        display: none;
      }
      .plot-settings-actions {
        display: flex;
        flex-direction: column;
        gap: 0;
        margin-top: 12px;
        padding-left: 0;
        padding-right: 0;
      }
      .plot-settings-btn-action {
        flex: 1;
        background: #ffffff;
        color: #0f172a;
        border: 1px solid transparent;
        border-radius: 8px;
        padding: 6px 0;
        font-weight: 400;
        font-size: 11px;
        cursor: pointer;
        transition: background-color 0.1s, border-color 0.1s, color 0.1s;
        text-align: center;
      }
      .plot-settings-btn-action:hover {
        background: #eef2f7;
        border-color: transparent;
        color: #0f172a;
      }
      .plot-settings-btn-action:disabled,
      .plot-settings-btn-action[aria-disabled="true"] {
        background: #f1f5f9;
        color: #94a3b8;
        cursor: not-allowed;
        opacity: 0.7;
      }
      .plot-settings-btn-action:disabled:hover,
      .plot-settings-btn-action[aria-disabled="true"]:hover {
        background: #f1f5f9;
        color: #94a3b8;
      }
      .plot-settings-btn-secondary {
        background: #ffffff;
        color: #0f172a;
        border: 1px solid transparent;
      }
      .plot-settings-btn-secondary:hover {
        background: #eef2f7;
        border-color: transparent;
        color: #0f172a;
      }
    `;
