// The text a terminal would show for a captured byte stream: login commands draw with cursor moves
// (claude setup-token is an Ink app that places each word with CSI G), so stripping escapes is not
// enough. A small screen model: rows of characters, the cursor, and the moves these tools use.
export function screenText(raw) {
  const rows = [[]];
  let r = 0;
  let c = 0;
  const row = () => {
    while (rows.length <= r) rows.push([]);
    return rows[r];
  };
  const put = (ch) => {
    const line = row();
    while (line.length < c) line.push(" ");
    line[c++] = ch;
  };
  const chars = [...raw];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === "\x1b") {
      const next = chars[i + 1];
      if (next === "[") {
        let j = i + 2;
        let params = "";
        while (j < chars.length && /[0-9;?<>=!]/.test(chars[j])) params += chars[j++];
        const cmd = chars[j];
        const n = params.split(";").map((p) => Number(p.replace(/\D/g, "")) || 0);
        if (cmd === "G") c = Math.max(0, (n[0] || 1) - 1);
        else if (cmd === "C") c += n[0] || 1;
        else if (cmd === "D") c = Math.max(0, c - (n[0] || 1));
        else if (cmd === "A") r = Math.max(0, r - (n[0] || 1));
        else if (cmd === "B") r += n[0] || 1;
        else if (cmd === "H" || cmd === "f") {
          r = Math.max(0, (n[0] || 1) - 1);
          c = Math.max(0, (n[1] || 1) - 1);
        } else if (cmd === "K") row().length = Math.min(row().length, c);
        else if (cmd === "J" && n[0] === 2) {
          rows.length = 0;
          rows.push([]);
          r = 0;
          c = 0;
        }
        i = j;
        continue;
      }
      if (next === "]") {
        // OSC: up to BEL or ESC \.
        let j = i + 2;
        while (j < chars.length && chars[j] !== "\x07" && !(chars[j] === "\x1b" && chars[j + 1] === "\\")) j++;
        i = chars[j] === "\x07" ? j : j + 1;
        continue;
      }
      i++;
      continue;
    }
    if (ch === "\r") c = 0;
    else if (ch === "\n") {
      r++;
      c = 0;
    } else if (ch === "\b") c = Math.max(0, c - 1);
    else if (ch >= " ") put(ch);
  }
  return rows
    .map((l) => l.join("").replace(/\s+$/, ""))
    .join("\n")
    .replace(/\n+$/, "");
}
