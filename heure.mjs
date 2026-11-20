/**
 * L'heure du réseau : l'en-tête `Date` d'une requête au propre serveur de la page
 * (même origine, jamais un service tiers) — brief 0020, B, étape 2.
 * Le calcul est dans decision.mjs ; ce module ne fait que les requêtes.
 */
import { mesurerEcart, reseauMs, prochaineLimite } from "./decision.mjs";

const REQUETES = 3;

/** Une requête HEAD sur la page elle-même, avec une chaîne de requête qui change à chaque fois. */
async function une(i) {
  const url = `./?heure=${Date.now()}-${i}-${Math.random().toString(36).slice(2)}`;
  const debutMs = Date.now();
  const reponse = await fetch(url, { method: "HEAD", cache: "no-store" });
  const finMs = Date.now();
  const entete = reponse.headers.get("Date");
  const dateServeurMs = entete ? Date.parse(entete) : NaN;
  return { debutMs, finMs, dateServeurMs };
}

/** Mesure l'écart de l'ordinateur ; null sans réseau, ou si l'en-tête `Date` n'est pas lisible. */
export async function mesurerReseau() {
  const mesures = [];
  for (let i = 0; i < REQUETES; i++) {
    try { mesures.push(await une(i)); } catch (e) { /* sans réseau */ }
  }
  return mesurerEcart(mesures);
}

/** Attend la prochaine limite de seconde de l'heure du réseau ; rend la seconde qui commence. */
export async function attendreLimite(ecartMs) {
  const { t, attenteMs } = prochaineLimite(Date.now(), ecartMs);
  // une attente grossière, puis une fine : la minuterie d'un navigateur dérive de quelques ms
  if (attenteMs > 30) await new Promise((r) => setTimeout(r, attenteMs - 20));
  while (reseauMs(Date.now(), ecartMs) < t * 1000) { /* le dernier cheveu */ }
  return t;
}
