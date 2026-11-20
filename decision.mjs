/**
 * La logique de la page de secours : lire une ligne STATE, comparer des instants,
 * choisir ce qu'on propose, contrôler une image (brief 0020, B).
 *
 * Aucun accès au port, au réseau ni au DOM : des fonctions pures, que `node --test`
 * juge sans dépendance. Tous les instants de ce module sont en secondes depuis le
 * 1er janvier 1970, en temps universel, sauf ceux dont le nom finit par `Ms`.
 * Toute comparaison se fait contre l'heure du réseau, jamais contre l'horloge de
 * l'ordinateur seule.
 */

/** Au-delà, une heure « bonne » n'est plus une dérive du module RTC mais une erreur (brief 0020, B, étape 4). */
export const LIMITE_HEURE_S = 600;
/** Au-delà, la page refuse d'écrire : l'ordinateur est mal réglé (ADR-0001, amendement du 2026-11-12). */
export const LIMITE_ORDINATEUR_S = 60;
/** Après une remise à l'heure, l'estimation de la carte peut retarder de près de 2 s (deux arrondis par défaut). */
export const TOLERANCE_APRES_S = 3;
/** La zone du programme : adresse et taille (programme/partitions.csv). */
export const ADRESSE_PROGRAMME = 0x10000;
export const TAILLE_MAX_PROGRAMME = 0x100000;
/** L'identifiant USB de l'USB-Serial-JTAG de l'ESP32-C3. */
export const FILTRE_USB = { usbVendorId: 0x303a, usbProductId: 0x1001 };

const ETATS_RTC = ["good", "lost", "invalid", "absent"];
const CAUSES = ["none", "config", "time", "calibration", "pole"];

/**
 * Lit une ligne STATE du programme d'un exemplaire, dans ses deux formes : la version 1
 * (sans `cause` ni `version`) vaut `cause=none`, `version=1`.
 * @returns {object|null} null si la ligne n'est pas un STATE lisible
 */
export function lireState(ligne) {
  if (typeof ligne !== "string") return null;
  const texte = ligne.trim();
  if (!texte.startsWith("STATE ")) return null;
  const champs = {};
  for (const jeton of texte.slice(6).split(/\s+/)) {
    const i = jeton.indexOf("=");
    if (i > 0) champs[jeton.slice(0, i)] = jeton.slice(i + 1);
  }
  if (!ETATS_RTC.includes(champs.rtc)) return null;
  if (!/^-?\d+$/.test(champs.estimate ?? "")) return null;
  const cause = champs.cause ?? "none";
  if (!CAUSES.includes(cause)) return null;
  let version = 1;
  if (champs.version !== undefined) {
    if (!/^\d+$/.test(champs.version)) return null;
    version = Number(champs.version);
  }
  return {
    mode: champs.mode ?? "",
    rtc: champs.rtc,
    estimate: Number(champs.estimate),
    cause,
    version,
    brute: texte,
  };
}

/**
 * Ce que la page propose, d'après STATE et l'heure du réseau (tableau de l'étape 4).
 * @param {object} state rendu par lireState
 * @param {number} reseauS l'heure du réseau, en secondes, au moment de la réponse
 * @returns {{action: "remettre"|"rien"|"debrancher", juste: boolean, ecartS: number|null, raison: string}}
 */
export function decider(state, reseauS) {
  // Une cause d'échec autre que « time », ou un module RTC absent : rien à proposer ici.
  if (state.rtc === "absent" || (state.cause !== "none" && state.cause !== "time")) {
    return { action: "debrancher", juste: false, ecartS: null, raison: state.rtc === "absent" ? "rtc-absent" : "cause-" + state.cause };
  }
  if (state.rtc === "lost" || state.rtc === "invalid") {
    return { action: "remettre", juste: false, ecartS: null, raison: "heure-" + state.rtc };
  }
  // rtc = good : jugée contre l'heure du réseau, à 10 min près.
  const ecartS = state.estimate - reseauS;
  if (Math.abs(ecartS) > LIMITE_HEURE_S) {
    return { action: "remettre", juste: false, ecartS, raison: "heure-decalee" };
  }
  return { action: "rien", juste: true, ecartS, raison: "juste" };
}

/** La remise à l'heure a réussi : l'heure est bonne, à 3 s de l'heure du réseau. */
export function justeApres(state, reseauS) {
  return state.rtc === "good" && Math.abs(state.estimate - reseauS) <= TOLERANCE_APRES_S;
}

/** L'ordinateur est assez juste pour qu'on écrive son heure du réseau (|écart| <= 60 s). */
export function ordinateurAssezJuste(ecartOrdinateurS) {
  return Math.abs(ecartOrdinateurS) <= LIMITE_ORDINATEUR_S;
}

/**
 * La mesure de l'heure du réseau : parmi les mesures, celle du plus court aller-retour.
 * Une mesure : { debutMs, finMs, dateServeurMs } — l'horloge de l'ordinateur à l'envoi et à
 * la réception, et l'en-tête `Date` du serveur (arrondi à la seconde inférieure).
 * @returns {{ecartMs: number, allerRetourMs: number}|null} l'écart de l'ordinateur (son horloge
 *   moins l'heure du réseau), positif quand l'ordinateur avance
 */
export function mesurerEcart(mesures) {
  let meilleure = null;
  for (const m of mesures) {
    if (!Number.isFinite(m.debutMs) || !Number.isFinite(m.finMs) || !Number.isFinite(m.dateServeurMs)) continue;
    const allerRetourMs = m.finMs - m.debutMs;
    if (allerRetourMs < 0) continue;
    if (meilleure === null || allerRetourMs < meilleure.allerRetourMs) {
      meilleure = { allerRetourMs, ecartMs: (m.debutMs + m.finMs) / 2 - m.dateServeurMs };
    }
  }
  return meilleure;
}

/** L'heure du réseau, en ms, quand l'horloge de l'ordinateur marque `horlogeMs`. */
export function reseauMs(horlogeMs, ecartMs) {
  return horlogeMs - ecartMs;
}

/**
 * La prochaine limite de seconde de l'heure du réseau.
 * @returns {{t: number, attenteMs: number}} la seconde qui commence, et le temps à attendre
 */
export function prochaineLimite(horlogeMs, ecartMs) {
  const maintenant = reseauMs(horlogeMs, ecartMs);
  const t = Math.floor(maintenant / 1000) + 1;
  return { t, attenteMs: t * 1000 - maintenant };
}

/** L'ordre d'une mise à l'heure : le seul avec STATE que la page envoie (serie.mjs). */
export function ordreSet(t) {
  if (!Number.isSafeInteger(t) || t <= 0) throw new RangeError("instant invalide");
  return `SET ${t}\n`;
}

/** SHA-256 en hexadécimal, par l'implémentation `subtle` fournie (crypto.subtle). */
export async function sha256Hex(subtle, octets) {
  const somme = new Uint8Array(await subtle.digest("SHA-256", octets));
  return Array.from(somme, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Le contrôle de l'image avant toute écriture : taille, premier octet, SHA-256 du manifeste.
 * @param {Uint8Array} octets l'image chargée
 * @param {object} manifeste { version, commit, taille, sha256 }
 * @param {object} subtle crypto.subtle
 * @returns {Promise<{ok: boolean, raison?: string}>}
 */
export async function controlerImage(octets, manifeste, subtle) {
  if (!(octets instanceof Uint8Array) || octets.length === 0) return { ok: false, raison: "vide" };
  if (octets.length > TAILLE_MAX_PROGRAMME) return { ok: false, raison: "trop-grande" };
  if (!manifeste || typeof manifeste.sha256 !== "string") return { ok: false, raison: "manifeste" };
  if (manifeste.taille !== octets.length) return { ok: false, raison: "taille" };
  if (octets[0] !== 0xe9) return { ok: false, raison: "entete" };
  const somme = await sha256Hex(subtle, octets);
  if (somme !== manifeste.sha256.toLowerCase()) return { ok: false, raison: "sha256" };
  return { ok: true };
}

/** La page ne sert que dans un navigateur qui sait parler au port (Chrome, Edge). */
export function navigateurCompatible(nav) {
  return Boolean(nav && nav.serial && typeof nav.serial.requestPort === "function");
}

/** La ligne de diagnostic à recopier : la dernière ligne STATE telle quelle, et l'écart de l'ordinateur. */
export function ligneDiagnostic(ligneState, ecartOrdinateurS) {
  const etat = ligneState ?? "aucune réponse";
  const ecart = ecartOrdinateurS === null || ecartOrdinateurS === undefined
    ? "inconnu"
    : `${ecartOrdinateurS >= 0 ? "+" : ""}${ecartOrdinateurS.toFixed(1)} s`;
  return `${etat} | écart de l'ordinateur ${ecart}`;
}
