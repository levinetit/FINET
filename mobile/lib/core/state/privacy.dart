import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Comutatorul „ascunde sumele” din bara de sus (promptul Android §6): sumele devin „••••”.
/// Nu se păstrează pe disc; revine la „vizibile” la repornire și la deconectare.
class HideAmounts extends Notifier<bool> {
  @override
  bool build() => false;

  void toggle() => state = !state;

  void reset() => state = false;
}

final hideAmountsProvider = NotifierProvider<HideAmounts, bool>(
  HideAmounts.new,
);
