const STOPWORDS = {
  en: "the and you that was for are with his they this have from not but what all were when your can said there she which their will would been has her him how its our out who did don't i'm it's you're just know".split(" "),
  es: "que de no la el es y en lo un por qué me una te los se con para mi está si bien pero yo eso las sí su tu aquí del al como le más esto ya todo esta vamos muy hay ahora algo estoy tengo nada cuando".split(" "),
  fr: "je de est pas le vous la tu que un il et à les ne en ce une ça qui on pour des mais me dans elle bien moi avec tout nous suis sur c'est j'ai oui non qu'il rien fait".split(" "),
  de: "ich sie das ist du nicht die und es der was wir zu ein er in mir mit ja wie den auf mich dass so hier wenn hat sind noch nein habe kann bin dich ihr aber auch".split(" "),
  it: "che non di è la il un per mi ti ho una sono le si ma cosa lo sei me con io bene questo come gli hai qui della mio no sì cosa perché fatto allora".split(" "),
  pt: "que não de um é eu o uma você se do da para isso com os me está em mas no na por ele tem bem sim meu aqui ela foi vai estou como isso fazer nós".split(" "),
  nl: "ik je het de dat is een niet en wat van we in ze hij op te zijn er maar met voor mij die heb jij weet nee ja dit hier kan wil was ben goed".split(" "),
};
const LISTS = Object.fromEntries(Object.entries(STOPWORDS).map(([code, words]) => [code, new Set(words)]));
const CUES = 200;
const MINIMUM = 12;

export function stripSpans(text, start, close, replacement = "") {
  const opening = new RegExp(start.source, start.flags.includes("g") ? start.flags : start.flags + "g");
  let out = "",
    from = 0;
  for (let match; (match = opening.exec(text)); ) {
    const end = text.indexOf(close, opening.lastIndex);
    if (end < 0) break;
    out += text.slice(from, match.index) + replacement;
    from = opening.lastIndex = end + close.length;
  }
  return out + text.slice(from);
}

export function subtitleLines(text) {
  const lines = [];
  let cues = 0;
  for (const raw of String(text || "").replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.trim();
    if (!line || /^WEBVTT/.test(line) || /^\d+$/.test(line)) continue;
    if (/-->/.test(line)) {
      if (++cues > CUES) break;
      continue;
    }
    lines.push(stripSpans(stripSpans(line, /</, ">", " "), /\{/, "}", " "));
  }
  return lines;
}

export function detectLanguage(text) {
  const words = subtitleLines(text)
    .join(" ")
    .toLowerCase()
    .split(/[^\p{L}']+/u)
    .filter(Boolean);
  const scores = Object.entries(LISTS)
    .map(([code, list]) => [code, words.reduce((total, word) => total + (list.has(word) ? 1 : 0), 0)])
    .sort((a, b) => b[1] - a[1]);
  const [[best, top], [, second]] = scores;
  return top >= MINIMUM && top >= second * 1.5 ? best : null;
}
