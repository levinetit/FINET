import 'dart:async';

import 'package:finet_mobile/core/router.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/scan_rig.dart';

/// Ecrane principale: file de jos și ecranele deschise din „Mai mult".
const _tabs = ['Acasă', 'Tranzacții', 'Scanează', 'Rapoarte', 'Mai mult'];
const _pushed = [
  '/budgets',
  '/recurring',
  '/receipts',
  '/statements',
  '/settings',
  '/profile',
  '/matches',
];

/// Ecran mic (360×640 dp), font la 200%, și ecran de tabletă (800×1280 dp): nicio depășire de
/// layout (un `RenderFlex overflow` ar arunca o excepție și ar pica testul).
Future<ScanRig> openApp(
  WidgetTester tester, {
  required Size dp,
  required double textScale,
}) async {
  final r = await ScanRig.open(tester, openScan: false);
  const dpr = 2.0;
  tester.view.physicalSize = Size(dp.width * dpr, dp.height * dpr);
  tester.view.devicePixelRatio = dpr;
  tester.platformDispatcher.textScaleFactorTestValue = textScale;
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  await tester.pumpAndSettle();
  return r;
}

void main() {
  const configs = {
    'ecran mic, font 200%': (Size(360, 640), 2.0),
    'tabletă, font 100%': (Size(800, 1280), 1.0),
    'ecran mic, font 130%': (Size(360, 640), 1.3),
  };

  for (final entry in configs.entries) {
    group(entry.key, () {
      testWidgets('filele principale se afișează fără depășiri', (
        tester,
      ) async {
        await openApp(tester, dp: entry.value.$1, textScale: entry.value.$2);
        for (final tab in _tabs) {
          await tester.tap(find.widgetWithText(NavigationDestination, tab));
          await tester.pumpAndSettle();
        }
      });

      testWidgets('ecranele secundare se afișează fără depășiri', (
        tester,
      ) async {
        final r = await openApp(
          tester,
          dp: entry.value.$1,
          textScale: entry.value.$2,
        );
        final router = r.h.container.read(routerProvider);
        for (final path in _pushed) {
          unawaited(router.push<void>(path));
          await tester.pumpAndSettle();
          router.pop();
          await tester.pumpAndSettle();
        }
      });
    });
  }

  group('ghidurile de accesibilitate', () {
    for (final tab in _tabs) {
      testWidgets('$tab: ținte atingere ≥ 48 dp, etichete', (tester) async {
        final handle = tester.ensureSemantics();
        await openApp(tester, dp: const Size(360, 800), textScale: 1.0);
        await tester.tap(find.widgetWithText(NavigationDestination, tab));
        await tester.pumpAndSettle();
        await expectLater(tester, meetsGuideline(androidTapTargetGuideline));
        await expectLater(tester, meetsGuideline(labeledTapTargetGuideline));
        handle.dispose();
      });
    }

    testWidgets('contrast suficient pe Acasă', (tester) async {
      final handle = tester.ensureSemantics();
      await openApp(tester, dp: const Size(360, 800), textScale: 1.0);
      await expectLater(tester, meetsGuideline(textContrastGuideline));
      handle.dispose();
    });
  });
}
