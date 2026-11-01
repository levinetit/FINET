import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Comutatorul „ascunde sumele” din bara de sus (promptul Android §6): sumele devin „••••”.
/// Nu se păstrează pe disc în Faza A; revine la „vizibile” la repornire.
class HideAmounts extends Notifier<bool> {
  @override
  bool build() => false;

  void toggle() => state = !state;
}

final hideAmountsProvider = NotifierProvider<HideAmounts, bool>(
  HideAmounts.new,
);
