/**
 * L'écran de la réparation (reparer.html) — brief 0020, B.
 *
 * Une seule écriture : l'image `programme.bin` à 0x10000, sans effacer la mémoire, avec
 * esptool-js. Ni fichier choisi par l'utilisateur, ni autre adresse, ni effacement.
 * L'image est contrôlée (taille, premier octet, SHA-256 du manifeste) avant d'écrire.
 */
import { ESPLoader, Transport } from "./bundle.js";
import {
  ADRESSE_PROGRAMME, FILTRE_USB, controlerImage, navigateurCompatible, ligneDiagnostic,
} from "./decision.mjs";
import { Liaison, choisirPort } from "./serie.mjs";

const $ = (id) => document.getElementById(id);
const ESSAIS = 3;
const PREVENIR_ENSUITE = "prévenez la personne qui vous a offert l'objet.";
const SANS_TERMINAL = { clean() {}, writeLine() {}, write() {} };

function dire(texte, ton = "") {
  const m = $("message");
  m.textContent = texte;
  m.className = ton;
}

function proposer(libelle, surClic) {
  const b = $("action");
  b.onclick = null;
  if (!libelle) { b.hidden = true; return; }
  b.textContent = libelle;
  b.hidden = false;
  b.disabled = false;
  b.onclick = async () => {
    b.disabled = true;
    try { await surClic(); } catch (e) { console.error(e); dire("Cela n'a pas marché. Débranchez l'objet, rebranchez-le, puis recommencez. Si cela se répète, " + PREVENIR_ENSUITE, "alerte"); proposer("Recommencer", choisir); }
  };
}

function avancement(ecrit, total) {
  const p = $("avancement");
  p.hidden = false;
  p.value = total > 0 ? Math.round((100 * ecrit) / total) : 0;
}

const CONSIGNE_BOUTON = "Débranchez l'objet. Tenez enfoncé le bouton de l'objet, rebranchez-le, puis relâchez le bouton. Ensuite recommencez.";

/** Choisit le port puis tente de s'y connecter, trois fois au plus. */
async function choisir() {
  $("avancement").hidden = true;
  let port;
  try {
    port = await navigator.serial.requestPort({ filters: [FILTRE_USB] });
  } catch (e) {
    dire("Aucun objet n'est proposé. " + CONSIGNE_BOUTON, "alerte");
    proposer("Choisir l'objet", choisir);
    return;
  }
  for (let essai = 1; essai <= ESSAIS; essai++) {
    dire(`Connexion à l'objet… (essai ${essai} sur ${ESSAIS})`);
    const transport = new Transport(port, false);
    const chargeur = new ESPLoader({ transport, baudrate: 115200, romBaudrate: 115200, terminal: SANS_TERMINAL });
    try {
      const puce = await chargeur.main();
      if (!String(puce).startsWith("ESP32-C3")) {
        await transport.disconnect();
        dire("Ce n'est pas le bon objet : la page ne touche à rien.", "alerte");
        proposer("Choisir l'objet", choisir);
        return;
      }
      await ecrire(chargeur, transport);
      return;
    } catch (e) {
      console.error(e);
      try { await transport.disconnect(); } catch (e2) { /* déjà fermé */ }
    }
  }
  dire("La connexion n'a pas pris. " + CONSIGNE_BOUTON, "alerte");
  proposer("Recommencer", choisir);
}

async function chargerImage() {
  const [rb, rm] = await Promise.all([
    fetch("./programme.bin", { cache: "no-store" }),
    fetch("./programme.json", { cache: "no-store" }),
  ]);
  if (!rb.ok || !rm.ok) throw new Error("programme introuvable");
  return { octets: new Uint8Array(await rb.arrayBuffer()), manifeste: await rm.json() };
}

async function ecrire(chargeur, transport) {
  dire("Contrôle du programme…");
  const { octets, manifeste } = await chargerImage();
  const controle = await controlerImage(octets, manifeste, crypto.subtle);
  if (!controle.ok) {
    await transport.disconnect();
    dire("Le programme à écrire n'est pas valide, la page n'écrit rien. " + PREVENIR_ENSUITE.charAt(0).toUpperCase() + PREVENIR_ENSUITE.slice(1), "alerte");
    proposer(null);
    return;
  }
  dire("Écriture du programme… Ne débranchez pas l'objet.");
  await chargeur.writeFlash({
    fileArray: [{ data: octets, address: ADRESSE_PROGRAMME }],
    flashMode: "keep",
    flashFreq: "keep",
    flashSize: "keep",
    eraseAll: false,
    compress: true,
    reportProgress: (indice, ecrit, total) => avancement(ecrit, total),
  });
  try { await chargeur.after("hard_reset"); } catch (e) { /* la carte repart : le port peut disparaître */ }
  try { await transport.disconnect(); } catch (e) { /* idem */ }
  dire("C'est écrit. Débranchez l'objet, rebranchez-le sans toucher au bouton, puis cliquez sur « Vérifier l'objet ».", "ok");
  proposer(null);
  const b = $("etat");
  b.hidden = false;
  b.onclick = verifier;
}

/** Lit STATE après la réparation. */
async function verifier() {
  $("etat").hidden = true;
  let ligne = null;
  try {
    const port = await choisirPort();
    const liaison = new Liaison(port);
    await liaison.ouvrir();
    const rendu = await liaison.trouverState(20000);
    await liaison.fermer();
    if (rendu) ligne = rendu.state.brute;
    if (rendu && rendu.state.cause === "none") {
      dire(`L'objet répond (programme version ${rendu.state.version}).`, "ok");
    } else if (rendu) {
      dire("L'objet répond, mais signale un souci : " + PREVENIR_ENSUITE, "alerte");
    } else {
      dire("L'objet ne répond pas. Débranchez-le, rebranchez-le, puis recommencez la vérification.", "alerte");
      $("etat").hidden = false;
    }
  } catch (e) {
    console.error(e);
    dire("La vérification n'a pas marché. Débranchez l'objet, rebranchez-le, puis recommencez.", "alerte");
    $("etat").hidden = false;
  }
  $("diagnostic").value = ligneDiagnostic(ligne, null);
  $("diagnostic-zone").hidden = false;
}

if (!navigateurCompatible(navigator)) {
  dire("Ouvrez cette page avec Google Chrome ou Microsoft Edge, sur un ordinateur.", "alerte");
} else {
  dire("Branchez l'objet à l'ordinateur avec son câble USB, puis cliquez sur le bouton.");
  proposer("Choisir l'objet", choisir);
}
