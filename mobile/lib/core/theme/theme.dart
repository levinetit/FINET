import 'package:flutter/material.dart';

import 'tokens.dart';

/// Familiile de fonturi incluse în aplicație (`pubspec.yaml`; fără rețea, fără CDN).
const String fontDisplay = 'BricolageGrotesque';
const String fontText = 'IBMPlexSans';
const String fontMono = 'IBMPlexMono';

FontWeight _weightFor(double wght) {
  final w = ((wght / 100).round() * 100).clamp(100, 900);
  return FontWeight.values[w ~/ 100 - 1];
}

TextStyle _style(
  String family,
  double size,
  double wght, {
  double? height,
  double? spacing,
}) {
  return TextStyle(
    fontFamily: family,
    fontSize: size,
    fontWeight: _weightFor(wght),
    // Fonturile variabile: axa de greutate se setează explicit, ca să nu depindă de motor.
    fontVariations: [FontVariation('wght', wght)],
    height: height,
    letterSpacing: spacing,
  );
}

/// Stilul sumelor în coloane: IBM Plex Mono cu cifre tabulare.
TextStyle amountStyle(double size, {bool bold = false}) => TextStyle(
  fontFamily: fontMono,
  fontSize: size,
  fontWeight: bold ? FontWeight.w600 : FontWeight.w400,
  fontFeatures: const [FontFeature.tabularFigures()],
);

TextTheme _textTheme(Color fg) {
  return TextTheme(
    displaySmall: _style(fontDisplay, 32, 700, height: 1.15, spacing: -0.5),
    headlineMedium: _style(fontDisplay, 26, 700, height: 1.2, spacing: -0.3),
    headlineSmall: _style(fontDisplay, 22, 700, height: 1.25),
    titleLarge: _style(fontDisplay, 20, 700, height: 1.25),
    titleMedium: _style(fontText, 16, 600, height: 1.4),
    titleSmall: _style(fontText, 14, 600, height: 1.4),
    bodyLarge: _style(fontText, 16, 400, height: 1.5),
    bodyMedium: _style(fontText, 14, 400, height: 1.5),
    bodySmall: _style(fontText, 12, 400, height: 1.45),
    labelLarge: _style(fontText, 14, 600, height: 1.3),
    labelMedium: _style(fontText, 12, 600, height: 1.3),
    labelSmall: _style(fontText, 11, 500, height: 1.3),
  ).apply(bodyColor: fg, displayColor: fg);
}

/// Tema Material 3 construită din tokenii FINET.
ThemeData buildTheme(Brightness brightness) {
  final c = brightness == Brightness.light
      ? FinetColors.light
      : FinetColors.dark;
  final dark = brightness == Brightness.dark;
  final scheme = ColorScheme(
    brightness: brightness,
    primary: c.accent,
    onPrimary: dark ? c.bg : Colors.white,
    secondary: c.accent,
    onSecondary: dark ? c.bg : Colors.white,
    tertiary: c.marker,
    onTertiary: const Color(0xFF14201C),
    error: c.bad,
    onError: dark ? c.bg : Colors.white,
    surface: c.surface,
    onSurface: c.fg,
    onSurfaceVariant: c.muted,
    outline: c.line,
    outlineVariant: c.line,
    surfaceContainerLowest: c.bg,
    surfaceContainerLow: c.surface,
    surfaceContainer: c.surface,
    surfaceContainerHigh: c.surface,
    surfaceContainerHighest: c.bg,
  );
  final text = _textTheme(c.fg);
  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor: c.bg,
    canvasColor: c.bg,
    textTheme: text,
    extensions: [c],
    appBarTheme: AppBarTheme(
      backgroundColor: c.bg,
      foregroundColor: c.fg,
      elevation: 0,
      scrolledUnderElevation: 0,
      centerTitle: false,
      titleTextStyle: text.titleLarge,
    ),
    cardTheme: CardThemeData(
      color: c.surface,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: c.line),
      ),
    ),
    dividerTheme: DividerThemeData(color: c.line, space: 1, thickness: 1),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: c.surface,
      indicatorColor: c.accent.withValues(alpha: 0.14),
      surfaceTintColor: Colors.transparent,
      labelTextStyle: WidgetStatePropertyAll(text.labelSmall),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size(48, 48),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        textStyle: text.labelLarge,
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        minimumSize: const Size(48, 48),
        side: BorderSide(color: c.line),
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        textStyle: text.labelLarge,
      ),
    ),
  );
}
