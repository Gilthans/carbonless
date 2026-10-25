import { createContext, useContext } from "react";

/**
 * Whether the page this is rendered in is the one showing. Pages stay
 * mounted once visited and are hidden while another one shows (`KeptPages`);
 * a hidden page pauses whatever measures or follows the window, and gives
 * back the root styles it set. True outside a kept page.
 */
export const PageActive = createContext(true);

export const usePageActive = () => useContext(PageActive);
