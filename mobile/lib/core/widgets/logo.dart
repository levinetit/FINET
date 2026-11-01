import 'package:flutter/material.dart';

import '../theme/theme.dart';
import '../theme/tokens.dart';

/// Simbolul FINET: linia frântă dintr-un singur trait care urcă și se termină cu o monedă.
/// Geometria vine din SVG-ul din `docs/FINET_MASTER_PROMPT.md` §3.4 (`viewBox="1 2 17 22"`).
class FinetSymbolPainter extends CustomPainter {
  const FinetSymbolPainter({required this.line, required this.coin});

  final Color line;
  final Color coin;

  static const double _vx = 1, _vy = 2, _vw = 17, _vh = 22;

  @override
  void paint(Canvas canvas, Size size) {
    final scale = size.width / _vw < size.height / _vh
        ? size.width / _vw
        : size.height / _vh;
    final dx = (size.width - _vw * scale) / 2;
    final dy = (size.height - _vh * scale) / 2;
    Offset p(double x, double y) =>
        Offset(dx + (x - _vx) * scale, dy + (y - _vy) * scale);

    final path = Path()
      ..moveTo(p(1.5, 18.5).dx, p(1.5, 18.5).dy)
      ..lineTo(p(5, 18.5).dx, p(5, 18.5).dy)
      ..lineTo(p(7, 22.5).dx, p(7, 22.5).dy)
      ..lineTo(p(10, 5).dx, p(10, 5).dy)
      ..lineTo(p(12.6, 17).dx, p(12.6, 17).dy)
      ..lineTo(p(14.2, 13.5).dx, p(14.2, 13.5).dy)
      ..lineTo(p(16.5, 3.5).dx, p(16.5, 3.5).dy);
    canvas.drawPath(
      path,
      Paint()
        ..color = line
        ..style = PaintingStyle.stroke
        ..strokeWidth = 3.4 * scale
        ..strokeCap = StrokeCap.round
        ..strokeJoin = StrokeJoin.round,
    );
    canvas.drawCircle(p(16.5, 3.5), 1.9 * scale, Paint()..color = coin);
  }

  @override
  bool shouldRepaint(FinetSymbolPainter old) =>
      old.line != line || old.coin != coin;
}

/// Wordmark-ul FINET: „FIN” + simbol + „t”, cu eticheta de accesibilitate „FINET”.
class FinetLogo extends StatelessWidget {
  const FinetLogo({super.key, this.height = 28});

  final double height;

  @override
  Widget build(BuildContext context) {
    final c = context.finet;
    final fontSize = height * 0.95;
    return Semantics(
      label: 'FINET',
      excludeSemantics: true,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          Text(
            'FIN',
            style: TextStyle(
              fontFamily: fontDisplay,
              fontSize: fontSize,
              fontWeight: FontWeight.w800,
              fontVariations: const [FontVariation('wght', 800)],
              letterSpacing: -fontSize * 0.03,
              color: c.fg,
              height: 1,
            ),
          ),
          SizedBox(
            width: height * 0.62,
            height: height * 0.8,
            child: CustomPaint(
              painter: FinetSymbolPainter(line: c.accent, coin: c.marker),
            ),
          ),
          Text(
            't',
            style: TextStyle(
              fontFamily: fontDisplay,
              fontSize: fontSize,
              fontWeight: FontWeight.w600,
              fontVariations: const [FontVariation('wght', 600)],
              color: c.muted,
              height: 1,
            ),
          ),
        ],
      ),
    );
  }
}
