import { createContext, useContext } from "react";

/**
 * Whether the page this is rendered in is the one showing. Pages stay
 * mounted once visited and are hidden while another one shows (`KeptPages`);
 * a hidden page pauses whatever measures or follows the window, and gives
 * back the root styles it set. True outside a kept page.
 */
export const PageActive = createContext(true);

export const usePageActive = () => useContext(PageActive);

/**
 * Forgets the window scroll saved for this page, so it shows from the top
 * next time (its layout changed while hidden). A no-op outside a kept page.
 */
export const ForgetPageScroll = createContext<() => void>(() => {});

export const useForgetPageScroll = () => useContext(ForgetPageScroll);
