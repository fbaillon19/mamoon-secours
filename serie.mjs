/**
 * Le port de l'exemplaire, par Web Serial (brief 0020, B).
 *
 * C'est ici, et seulement ici, que la page de remise à l'heure écrit sur le port : un seul
 * point d'écriture (`#ecrire`), deux formes d'ordre, `STATE\n` et `SET <t>\n`. Un test juge
 * les sources (test/ordres.test.mjs). Rien d'autre ne passe, hors esptool-js.
 */
import { FILTRE_USB, lireState, ordreSet } from "./decision.mjs";

const encodeur = new TextEncoder();
const decodeur = new TextDecoder();
const ORDRE_STATE = "STATE\n";

/** Choisit un port parmi les objets de la carte (filtre USB) ; l'utilisateur est invité par le navigateur. */
export function choisirPort() {
  return navigator.serial.requestPort({ filters: [FILTRE_USB] });
}

/** Les ports déjà permis qui sont ceux de la carte. */
export async function portsPermis() {
  const tous = await navigator.serial.getPorts();
  return tous.filter((p) => {
    const i = p.getInfo();
    return i.usbVendorId === FILTRE_USB.usbVendorId && i.usbProductId === FILTRE_USB.usbProductId;
  });
}

export class Liaison {
  #port;
  #lecteur = null;
  #ecrivain = null;
  #tampon = "";
  #attentes = [];
  #dernierEnvoiState = 0;
  #fermee = false;

  /** Résolu quand le flux de lecture se termine : le port est fermé ou perdu. */
  perdu;
  #signalerPerte;
  /** La dernière ligne reçue, tel quel. */
  derniereLigne = "";
  /** Appelé pour chaque ligne reçue (texte, instant de réception en ms de l'horloge). */
  surLigne = () => {};

  constructor(port) {
    this.#port = port;
    this.perdu = new Promise((resolve) => { this.#signalerPerte = resolve; });
  }

  /** Ouvre le port, DTR et RTS à 0 aussitôt après, comme le poste (programme/tools/port_serie.py). */
  async ouvrir() {
    await this.#port.open({ baudRate: 115200 });
    try {
      await this.#port.setSignals({ dataTerminalReady: false, requestToSend: false });
    } catch (e) {
      // une plate-forme qui refuse setSignals : la lecture et l'ordre ne changent pas
    }
    this.#ecrivain = this.#port.writable.getWriter();
    this.#lecteur = this.#port.readable.getReader();
    this.#boucleLecture();
  }

  async #boucleLecture() {
    try {
      for (;;) {
        const { value, done } = await this.#lecteur.read();
        if (done) break;
        this.#tampon += decodeur.decode(value, { stream: true });
        let i;
        while ((i = this.#tampon.indexOf("\n")) >= 0) {
          const ligne = this.#tampon.slice(0, i).replace(/\r$/, "");
          this.#tampon = this.#tampon.slice(i + 1);
          this.#recevoir(ligne);
        }
      }
    } catch (e) {
      // le port a disparu (débranchement, redémarrage de la carte) : la perte suffit
    }
    this.#signalerPerte();
  }

  #recevoir(ligne) {
    const recuMs = Date.now();
    this.derniereLigne = ligne;
    this.surLigne(ligne, recuMs);
    for (const a of [...this.#attentes]) {
      const rendu = a.juge(ligne, recuMs);
      if (rendu !== undefined) {
        this.#attentes = this.#attentes.filter((x) => x !== a);
        clearTimeout(a.minuterie);
        a.resolve(rendu);
      }
    }
  }

  #attendre(juge, delaiMs) {
    return new Promise((resolve) => {
      const a = { juge, resolve };
      a.minuterie = setTimeout(() => {
        this.#attentes = this.#attentes.filter((x) => x !== a);
        resolve(null);
      }, delaiMs);
      this.#attentes.push(a);
    });
  }

  /** Le seul point d'écriture de la page : tout octet envoyé au port passe ici. */
  async #ecrire(octets) {
    await this.#ecrivain.write(octets);
  }

  /** Envoie `STATE\n`, daté : seule une réponse reçue après cet envoi sera jugée. */
  async envoyerState() {
    this.#dernierEnvoiState = Date.now();
    await this.#ecrire(encodeur.encode(ORDRE_STATE));
  }

  /** Attend la réponse à un STATE envoyé ; { state, recuMs } ou null au bout de `delaiMs`. */
  attendreState(delaiMs) {
    return this.#attendre((ligne, recuMs) => {
      if (recuMs < this.#dernierEnvoiState) return undefined;
      const state = lireState(ligne);
      return state ? { state, recuMs } : undefined;
    }, delaiMs);
  }

  /**
   * Envoie STATE toutes les 2 s jusqu'à une réponse, `totalMs` au plus (la carte peut redémarrer
   * à l'ouverture). { state, recuMs } ou null. `surEssai` est appelé à chaque envoi.
   */
  async trouverState(totalMs = 20000, surEssai = () => {}) {
    const fin = Date.now() + totalMs;
    while (Date.now() < fin && !this.#fermee) {
      surEssai();
      try { await this.envoyerState(); } catch (e) { return null; }
      const rendu = await this.attendreState(Math.min(2000, Math.max(0, fin - Date.now())));
      if (rendu) return rendu;
    }
    return null;
  }

  /** Envoie `SET <t>\n` et rend la réponse de la carte (`SET ok|refused|failed <t>`), ou null. */
  async envoyerSet(t, delaiMs = 4000) {
    const ordre = ordreSet(t);
    const reponse = this.#attendre((ligne) => (ligne.startsWith("SET ") ? ligne : undefined), delaiMs);
    await this.#ecrire(encodeur.encode(ordre));
    return reponse;
  }

  /** Attend la ligne START que la carte écrit en redémarrant ; la ligne, ou null. */
  attendreStart(delaiMs) {
    return this.#attendre((ligne) => (ligne.startsWith("START ") ? ligne : undefined), delaiMs);
  }

  async fermer() {
    this.#fermee = true;
    try { await this.#lecteur?.cancel(); } catch (e) { /* déjà perdu */ }
    try { this.#lecteur?.releaseLock(); } catch (e) { /* idem */ }
    try { this.#ecrivain?.releaseLock(); } catch (e) { /* idem */ }
    try { await this.#port.close(); } catch (e) { /* idem */ }
  }
}
