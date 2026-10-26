const LONG = { eng: "en", spa: "es", fre: "fr", fra: "fr", ger: "de", deu: "de", ita: "it", por: "pt", jpn: "ja", kor: "ko", chi: "zh", zho: "zh", rus: "ru", cat: "ca", dut: "nl", nld: "nl", swe: "sv", nor: "no", dan: "da", fin: "fi", pol: "pl", glg: "gl", baq: "eu", eus: "eu" };

export function languageCode(value) {
  const code = String(value || "").toLowerCase().split(/[-_]/)[0];
  return LONG[code] || code;
}

export function sameLanguage(a, b) {
  return !!languageCode(a) && languageCode(a) === languageCode(b);
}

export function channelLabel(channels) {
  if (channels >= 8) return "7.1";
  if (channels >= 6) return "5.1";
  if (channels === 2) return "2.0";
  if (channels === 1) return "Mono";
  return "";
}

export function audioOptions(playerTracks, libraryTracks) {
  const tracks = Array.isArray(playerTracks) ? playerTracks : [];
  const known = Array.isArray(libraryTracks) ? libraryTracks : [];
  const used = new Set();
  return tracks.map((track, index) => {
    const byOrder = known[index] && (!track.language || !known[index].language || sameLanguage(track.language, known[index].language)) ? index : -1;
    const byLanguage = known.findIndex((entry, at) => !used.has(at) && sameLanguage(entry.language, track.language));
    const at = byOrder >= 0 && !used.has(byOrder) ? byOrder : byLanguage;
    const match = at >= 0 ? known[at] : null;
    if (at >= 0) used.add(at);
    const name = match?.label || track.label || track.name || track.language || match?.language || `Track ${index + 1}`;
    const channels = channelLabel(match?.channels || 0);
    return {
      key: track.id || `${track.language || "track"}-${index}`,
      label: channels ? `${name} · ${channels}` : name,
      language: track.language || match?.language || "",
      track,
      stream: match ? match.stream : null,
      codec: match?.codec || "",
    };
  });
}

export function libraryAudioOptions(libraryTracks) {
  return (Array.isArray(libraryTracks) ? libraryTracks : []).map((entry, index) => {
    const name = entry.label || entry.language || `Track ${index + 1}`;
    const channels = channelLabel(entry.channels || 0);
    return {
      key: `stream:${entry.stream}`,
      label: channels ? `${name} · ${channels}` : name,
      language: entry.language || "",
      track: null,
      stream: entry.stream,
      codec: entry.codec || "",
    };
  });
}

export function currentAudio(options, current) {
  if (!current) return null;
  return (
    options.find((option) => option.track === current || (current.id && option.track.id === current.id)) ||
    options.find((option) => option.track.language === current.language && option.track.label === current.label) ||
    null
  );
}

export function rememberedAudio(options, language) {
  if (!language) return null;
  return options.find((option) => sameLanguage(option.language, language)) || null;
}
