/**
 * This function copies the text. It uses the clipboard API, and an older method when the browser
 * has no clipboard API. It gives false when neither method copies.
 */
export const copy = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard !== undefined) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // the page has no permission: try the older method
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
};
