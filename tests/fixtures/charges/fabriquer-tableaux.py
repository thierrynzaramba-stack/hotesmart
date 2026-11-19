# Fabrique trois tableaux d'amortissement FICTIFS pour les tests (aucune donnée réelle).
import sys
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4

def euros(c):
    s = f"{c // 100:,}".replace(",", " ") + "," + f"{c % 100:02d}"
    return s

def lignes(faute=None):
    out = [("", "15/01/2025", 0, 0, 25000, 0, None)]           # frais de dossier
    out.append(("", "20/01/2025", 0, 0, 0, 0, 12000000))         # deblocage : echeance 0
    crd = 12000000
    for i in range(1, 15):
        m = (i % 12) + 1; a = 2025 + (i // 12)
        it = crd // 1000                                        # 1,20 % l an
        ass = 3000
        cap = 70000 - it
        crd -= cap
        out.append((str(i), f"05/{m:02d}/{a}", it, ass, 0, cap, crd))
    out = [r + (0,) for r in out]
    if faute is not None:
        out[faute] = out[faute][:7] + (1,)                        # echeance faussee d'un centime
    return out

COLS = [("N°", "TERME"), ("DATE", "ECHEANCE"), ("MONTANT", "INTERETS"), ("MONTANT", "ASSURANCE"),
        ("MONTANT", "ACCESSOIRES"), ("CAPITAL", "AMORTI"), ("MONTANT", "ECHEANCE"), ("CAPITAL", "RESTANT DU")]
X = [20, 75, 180, 250, 320, 390, 460, 540]   # fin de colonne (montants cadres a droite)

def page(c, rows, entete, sansColonne=None, y0=760):
    y = y0
    c.setFont("Helvetica", 9)
    c.drawString(30, y0 + 45, "BANQUE EXEMPLE - TABLEAU D'AMORTISSEMENT (FICTIF)")
    if entete:
        for k, (h1, h2) in enumerate(COLS):
            if sansColonne is not None and k == sansColonne: continue
            c.drawRightString(X[k], y + 30, h1); c.drawRightString(X[k], y + 20, h2)
    for r in rows:
        rang, date, it, ass, acc, cap, crd, ecart = r
        ech = it + ass + acc + cap + ecart
        vals = [rang, date, euros(it), euros(ass), euros(acc), euros(cap), euros(ech), euros(crd) if crd is not None else ""]
        for k, v in enumerate(vals):
            if v: c.drawRightString(X[k], y, v)
        y -= 12
    c.drawString(30, y - 20, "TOTAL   (ligne sans date, ignoree)")
    c.showPage()

def tableau(chemin, faute=None, sansColonne=None, tourne=False):
    c = canvas.Canvas(chemin, pagesize=A4)
    rows = lignes(faute)
    for i, part in enumerate([rows[:9], rows[9:]]):
        if tourne:
            c.translate(0, 842); c.rotate(-90)   # texte tourne d'un quart de tour
        page(c, part, entete=(i == 0), sansColonne=sansColonne, y0=(530 if tourne else 760))
    c.save()

tableau(sys.argv[1] + "/tableau-portrait.pdf")
tableau(sys.argv[1] + "/tableau-tourne.pdf", tourne=True)
tableau(sys.argv[1] + "/tableau-ligne-fausse.pdf", faute=6)
tableau(sys.argv[1] + "/tableau-sans-capital.pdf", sansColonne=5)
