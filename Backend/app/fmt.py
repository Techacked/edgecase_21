"""Formatting helpers (Indian digit grouping, compact rupee amounts)."""


def _group_indian(n: int) -> str:
    s = str(abs(n))
    if len(s) <= 3:
        out = s
    else:
        head, tail = s[:-3], s[-3:]
        parts = []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        if head:
            parts.insert(0, head)
        out = ",".join(parts + [tail])
    return ("-" if n < 0 else "") + out


def inr(value: float, sym: str = "₹") -> str:
    return f"{sym}{_group_indian(int(round(value)))}"


def compact_inr(value: float, sym: str = "₹") -> str:
    v = abs(value)
    if v >= 1e7:
        out = f"{sym}{v / 1e7:.1f} Cr"
    elif v >= 1e5:
        out = f"{sym}{v / 1e5:.1f} L"
    else:
        out = f"{sym}{_group_indian(int(round(v)))}"
    return ("-" if value < 0 else "") + out


def tidy(x) -> int | float:
    x = round(float(x), 4)
    return int(x) if x.is_integer() else x


def fmt_value(var: dict, x) -> str:
    f = var.get("fmt")
    if f == "inr":
        return inr(x)
    if isinstance(f, list):
        return f[0] if bool(x) else f[1]
    if isinstance(f, str):
        step = var.get("step", 1)
        if step < 1:  # keep trailing zeros for decimal variables (CGPA 7.0, not 7)
            return f.format(f"{float(x):.{len(f'{step:.6f}'.rstrip('0').split('.')[1])}f}")
        return f.format(tidy(x))
    return str(tidy(x)) if not isinstance(x, (bool, str)) else str(x)


def pct(part: float, whole: float, digits: int = 1) -> float:
    return round(100.0 * part / whole, digits) if whole else 0.0
