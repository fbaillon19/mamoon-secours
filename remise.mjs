/**
 * L'écran de la remise à l'heure (index.html) — brief 0020, B.
 * Un seul bouton d'action à la fois ; les décisions viennent de decision.mjs.
 */
import { decider, justeApres, navigateurCompatible, ordinateurAssezJuste, reseauMs, ligneDiagnostic } from "./decision.mjs";
import { Liaison, choisirPort, portsPermis } from "./serie.mjs";
import { mesurerReseau, attendreLimite } from "./heure.mjs";

const $ = (id) => document.getElementById(id);
const PREVENIR = "Prévenez la personne qui vous a offert l'objet.";
const PREVENIR_ENSUITE = "prévenez la personne qui vous a offert l'objet.";

let ecartMs = null;          // l'écart de l'ordinateur, en ms (son horloge moins l'heure du réseau)
let liaison = null;
let derniereLigneState = null;

function dire(texte, ton = "") {
  const m = $("message");
  m.textContent = texte;
  m.className = ton;
}

/** Montre un seul bouton d'action (ou aucun). */
function proposer(libelle, surClic) {
  const b = $("action");
  b.onclick = null;
  if (!libelle) { b.hidden = true; return; }
  b.textContent = libelle;
  b.hidden = false;
  b.disabled = false;
  b.onclick = async () => {
    b.disabled = true;
    try { await surClic(); } catch (e) { echec(e); }
  };
}

function diagnostic() {
  const ecartS = ecartMs === null ? null : ecartMs / 1000;
  $("diagnostic").value = ligneDiagnostic(derniereLigneState, ecartS);
  $("diagnostic-zone").hidden = false;
}

function echec(e) {
  console.error(e);
  diagnostic();
  dire("Cela n'a pas marché. Débranchez l'objet, attendez dix secondes, rebranchez-le, puis rechargez cette page. "
    + "Si cela ne marche toujours pas, " + PREVENIR_ENSUITE, "alerte");
  proposer(null);
}

const reseauS = (recuMs) => reseauMs(recuMs, ecartMs) / 1000;

async function connecter() {
  let port;
  try {
    port = await choisirPort();
  } catch (e) {
    dire("Aucun objet n'a été choisi. Vérifiez que l'objet est branché à l'ordinateur par son câble, puis recommencez.", "alerte");
    proposer("Connecter l'objet", connecter);
    return;
  }
  await ouvrirEtLire(port);
}

async function ouvrirEtLire(port) {
  liaison = new Liaison(port);
  try {
    await liaison.ouvrir();
  } catch (e) {
    console.error(e);
    diagnostic();
    dire("Impossible d'ouvrir la connexion avec l'objet. Fermez les autres onglets ou programmes qui pourraient l'utiliser, "
      + "ou, sous Linux, ce droit manque peut-être à votre session. " + PREVENIR, "alerte");
    proposer("Réessayer", connecter);
    return;
  }
  liaison.surLigne = (ligne) => { if (ligne.startsWith("STATE ")) derniereLigneState = ligne; };
  await lireEtDecider();
}

async function lireEtDecider() {
  dire("Lecture de l'heure de l'objet…");
  proposer(null);
  const rendu = await liaison.trouverState(20000);
  if (!rendu) {
    diagnostic();
    dire("L'objet ne répond pas. Débranchez-le, rebranchez-le, puis recommencez.", "alerte");
    proposer("Recommencer", async () => { await liaison.fermer(); await connecter(); });
    return;
  }
  derniereLigneState = rendu.state.brute;
  const decision = decider(rendu.state, reseauS(rendu.recuMs));
  if (decision.action === "rien") {
    dire("L'heure de l'objet est juste. Il n'y a rien à faire.", "ok");
    proposer(null);
    diagnostic();
  } else if (decision.action === "debrancher") {
    diagnostic();
    dire("Il y a un souci que cette page ne règle pas. Débranchez l'objet, attendez dix secondes, rebranchez-le. "
      + "Si le petit voyant rouge se remet à pulser, " + PREVENIR_ENSUITE, "alerte");
    proposer(null);
  } else {
    dire(decision.raison === "heure-decalee"
      ? "L'heure de l'objet est décalée. Il faut la remettre."
      : "L'objet a perdu l'heure. Il faut la remettre.");
    proposer("Remettre l'heure", remettre);
  }
}

async function remettre() {
  if (!ordinateurAssezJuste(ecartMs / 1000)) {
    diagnostic();
    dire("L'heure de votre ordinateur n'est pas juste : l'objet ne serait pas à l'heure. "
      + "Réglez l'heure de l'ordinateur (réglage automatique), puis rechargez cette page.", "alerte");
    proposer(null);
    return;
  }
  dire("Remise à l'heure en cours…");
  const t = await attendreLimite(ecartMs);
  const reponse = await liaison.envoyerSet(t);
  if (reponse && !reponse.startsWith("SET ok")) {
    diagnostic();
    dire("L'objet a refusé l'heure. Débranchez-le, rebranchez-le, puis recommencez. Si cela se répète, " + PREVENIR_ENSUITE, "alerte");
    proposer(null);
    return;
  }
  dire("L'objet redémarre. Ne le débranchez pas.");
  await retrouverApresRedemarrage();
}

/** Le cas du port gardé (on attend START sur le même flux) et celui du port perdu (on le retrouve). */
async function retrouverApresRedemarrage() {
  const sorti = await Promise.race([liaison.attendreStart(12000), liaison.perdu.then(() => "perdu")]);
  if (sorti === "perdu") {
    await liaison.fermer();
    if (!(await reouvrirPermis(15000))) return proposerReconnexion();
  }
  // START reçu sur le même flux, ou ni START ni perte : dans les deux cas on relit STATE
  await verifierApres();
}

/** Retrouve la carte parmi les ports déjà permis, pendant `totalMs`. */
async function reouvrirPermis(totalMs) {
  const fin = Date.now() + totalMs;
  while (Date.now() < fin) {
    for (const port of await portsPermis()) {
      const l = new Liaison(port);
      try {
        await l.ouvrir();
        l.surLigne = (ligne) => { if (ligne.startsWith("STATE ")) derniereLigneState = ligne; };
        liaison = l;
        return true;
      } catch (e) { try { await l.fermer(); } catch (e2) { /* rien */ } }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function proposerReconnexion() {
  dire("L'objet a bien redémarré, mais la page ne le retrouve pas. Cliquez sur « Reconnecter l'objet ».");
  proposer(null);
  const b = $("reconnecter");
  b.hidden = false;
  b.onclick = async () => {
    b.hidden = true;
    try {
      const port = await choisirPort();
      liaison = new Liaison(port);
      await liaison.ouvrir();
      liaison.surLigne = (ligne) => { if (ligne.startsWith("STATE ")) derniereLigneState = ligne; };
      await verifierApres();
    } catch (e) { echec(e); }
  };
}

async function verifierApres() {
  dire("Vérification de l'heure…");
  const rendu = await liaison.trouverState(20000);
  if (!rendu) {
    diagnostic();
    dire("L'objet ne répond pas. Débranchez-le, rebranchez-le, puis rechargez cette page pour vérifier.", "alerte");
    return;
  }
  derniereLigneState = rendu.state.brute;
  diagnostic();
  if (justeApres(rendu.state, reseauS(rendu.recuMs))) {
    dire("C'est fait : l'objet est à l'heure. Si l'heure se perd de nouveau sans que vous ayez changé la pile, "
      + PREVENIR_ENSUITE, "ok");
  } else {
    dire("L'heure de l'objet n'est pas encore juste. Débranchez-le, rebranchez-le, puis recommencez. "
      + "Si cela se répète, " + PREVENIR_ENSUITE, "alerte");
    proposer("Recommencer", async () => { await lireEtDecider(); });
    return;
  }
  proposer(null);
}

async function demarrer() {
  if (!navigateurCompatible(navigator)) {
    dire("Ouvrez cette page avec Google Chrome ou Microsoft Edge, sur un ordinateur.", "alerte");
    return;
  }
  const mesure = await mesurerReseau();
  if (mesure === null) {
    dire("Cette page a besoin d'internet pour connaître l'heure exacte. Vérifiez la connexion de l'ordinateur, puis rechargez la page.", "alerte");
    return;
  }
  ecartMs = mesure.ecartMs;
  dire("Branchez l'objet à l'ordinateur avec son câble USB, puis cliquez sur le bouton.");
  proposer("Connecter l'objet", connecter);
}

demarrer();
