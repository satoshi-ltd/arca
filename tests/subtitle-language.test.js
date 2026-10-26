import test from "node:test";
import assert from "node:assert/strict";
import { detectLanguage, subtitleLines } from "../packages/core/subtitle-language.js";

const srt = (lines) => lines.map((line, index) => `${index + 1}\n00:00:${String(index).padStart(2, "0")},000 --> 00:00:${String(index).padStart(2, "0")},900\n${line}\n`).join("\n");

const SAMPLES = {
  en: ["I don't know what you want from me.", "<i>They were here when the war began.</i>", "You can't go back there, it's not safe.", "What did she say to him?", "We have been waiting for this all night.", "Tell me the truth and I will help you."],
  es: ["No sé qué quieres de mí.", "<i>Ellos estaban aquí cuando empezó la guerra.</i>", "No puedes volver allí, no es seguro.", "¿Qué le dijo ella?", "Hemos estado esperando esto toda la noche.", "Dime la verdad y te voy a ayudar, pero ahora vamos."],
  fr: ["Je ne sais pas ce que tu veux de moi.", "<i>Ils étaient là quand la guerre a commencé.</i>", "Tu ne peux pas y retourner, c'est pas sûr.", "Qu'est-ce qu'elle lui a dit ?", "On attend ça depuis toute la nuit.", "Dis-moi la vérité et je vais t'aider, mais moi aussi."],
  de: ["Ich weiß nicht, was du von mir willst.", "<i>Sie waren hier, als der Krieg begann.</i>", "Du kannst nicht dahin zurück, es ist nicht sicher.", "Was hat sie ihm gesagt?", "Wir haben die ganze Nacht darauf gewartet.", "Sag mir die Wahrheit und ich helfe dir, ja das kann ich."],
  it: ["Non so cosa vuoi da me.", "<i>Erano qui quando la guerra è cominciata.</i>", "Non puoi tornare lì, non è sicuro.", "Che cosa gli ha detto lei?", "Ho aspettato questo per tutta la notte.", "Dimmi la verità e ti aiuterò, perché sei qui con me."],
  pt: ["Eu não sei o que você quer de mim.", "<i>Eles estavam aqui quando a guerra começou.</i>", "Você não pode voltar lá, não é seguro.", "O que ela disse para ele?", "Nós estamos esperando isso a noite toda.", "Me diga a verdade e eu vou te ajudar, isso é bem fácil."],
  nl: ["Ik weet niet wat je van mij wil.", "<i>Ze waren hier toen de oorlog begon.</i>", "Je kan daar niet terug, het is niet veilig.", "Wat heeft ze tegen hem gezegd?", "We hebben de hele nacht op dit gewacht.", "Zeg mij de waarheid en ik help je, dat weet ik."],
};

test("a subtitle's language is detected from its words", () => {
  for (const [code, lines] of Object.entries(SAMPLES)) assert.equal(detectLanguage(srt(lines)), code, code);
});

test("text that is too short or mixed is not guessed", () => {
  assert.equal(detectLanguage(srt(["Okay.", "Bye."])), null);
  assert.equal(detectLanguage(srt([...SAMPLES.en.slice(0, 3), ...SAMPLES.es.slice(0, 3)])), null);
  assert.equal(detectLanguage(""), null);
});

test("timing lines, cue numbers and tags never count, and only the first 200 cues are read", () => {
  assert.deepEqual(subtitleLines("WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n<i>Hola</i> {\\an8}amigo\n"), [" Hola   amigo"]);
  const long = srt([...Array(200).fill("Okay."), ...SAMPLES.en, ...SAMPLES.en]);
  assert.equal(detectLanguage(long), null);
});
