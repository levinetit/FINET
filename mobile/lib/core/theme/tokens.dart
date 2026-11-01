import 'package:flutter/material.dart';

/// Tokenii de culoare FINET (`docs/FINET_MASTER_PROMPT.md` §3.4), temă luminoasă și întunecată.
/// Componentele nu scriu culori direct: le iau din `ColorScheme` sau din această extensie.
@immutable
class FinetColors extends ThemeExtension<FinetColors> {
  const FinetColors({
    required this.bg,
    required this.surface,
    required this.fg,
    required this.muted,
    required this.line,
    required this.accent,
    required this.marker,
    required this.paper,
    required this.ok,
    required this.warn,
    required this.bad,
  });

  final Color bg;
  final Color surface;
  final Color fg;
  final Color muted;
  final Color line;
  final Color accent;
  final Color marker;
  final Color paper;
  final Color ok;
  final Color warn;
  final Color bad;

  static const FinetColors light = FinetColors(
    bg: Color(0xFFF2F5F4),
    surface: Color(0xFFFFFFFF),
    fg: Color(0xFF14201C),
    muted: Color(0xFF586863),
    line: Color(0xFFD3DCD8),
    accent: Color(0xFF1F45B8),
    marker: Color(0xFFF6DC6B),
    paper: Color(0xFFFBFAF4),
    ok: Color(0xFF1D7F47),
    warn: Color(0xFFA8690F),
    bad: Color(0xFFBF3326),
  );

  static const FinetColors dark = FinetColors(
    bg: Color(0xFF0E1412),
    surface: Color(0xFF151D1A),
    fg: Color(0xFFE5ECE9),
    muted: Color(0xFF93A39D),
    line: Color(0xFF29352F),
    accent: Color(0xFF87A3FF),
    marker: Color(0xFFE3C446),
    paper: Color(0xFFECEBE3),
    ok: Color(0xFF4FC483),
    warn: Color(0xFFE2AB48),
    bad: Color(0xFFFF7466),
  );

  @override
  FinetColors copyWith({
    Color? bg,
    Color? surface,
    Color? fg,
    Color? muted,
    Color? line,
    Color? accent,
    Color? marker,
    Color? paper,
    Color? ok,
    Color? warn,
    Color? bad,
  }) {
    return FinetColors(
      bg: bg ?? this.bg,
      surface: surface ?? this.surface,
      fg: fg ?? this.fg,
      muted: muted ?? this.muted,
      line: line ?? this.line,
      accent: accent ?? this.accent,
      marker: marker ?? this.marker,
      paper: paper ?? this.paper,
      ok: ok ?? this.ok,
      warn: warn ?? this.warn,
      bad: bad ?? this.bad,
    );
  }

  @override
  FinetColors lerp(ThemeExtension<FinetColors>? other, double t) {
    if (other is! FinetColors) return this;
    return FinetColors(
      bg: Color.lerp(bg, other.bg, t)!,
      surface: Color.lerp(surface, other.surface, t)!,
      fg: Color.lerp(fg, other.fg, t)!,
      muted: Color.lerp(muted, other.muted, t)!,
      line: Color.lerp(line, other.line, t)!,
      accent: Color.lerp(accent, other.accent, t)!,
      marker: Color.lerp(marker, other.marker, t)!,
      paper: Color.lerp(paper, other.paper, t)!,
      ok: Color.lerp(ok, other.ok, t)!,
      warn: Color.lerp(warn, other.warn, t)!,
      bad: Color.lerp(bad, other.bad, t)!,
    );
  }
}

extension FinetColorsContext on BuildContext {
  /// Tokenii FINET ai temei curente.
  FinetColors get finet => Theme.of(this).extension<FinetColors>()!;
}
