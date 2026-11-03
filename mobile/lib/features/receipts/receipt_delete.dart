import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/network/api_error.dart';
import '../scan/providers.dart';
import 'providers.dart';

/// Confirmarea și ștergerea unui bon, la fel din toate locurile (butonul de la finalul
/// ecranului, meniul din bara de sus, lista de bonuri). Întoarce `true` doar dacă bonul a fost
/// șters; o eroare a serverului apare într-un mesaj scurt, nu rămâne ascunsă.
Future<bool> confirmAndDeleteReceipt(
  BuildContext context,
  WidgetRef ref,
  String receiptId,
) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  final ok = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('Ștergi bonul?'),
      content: const Text(
        'Se șterg bonul și pozele lui. Tranzacția creată din el rămâne.',
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text('Nu'),
        ),
        FilledButton(
          onPressed: () => Navigator.pop(context, true),
          child: const Text('Șterge'),
        ),
      ],
    ),
  );
  if (ok != true) return false;
  try {
    await ref.read(receiptsApiProvider).deleteReceipt(receiptId);
    await ref.read(receiptsControllerProvider.notifier).refresh();
    return true;
  } on ApiError catch (e) {
    messenger?.showSnackBar(SnackBar(content: Text(e.message)));
    return false;
  }
}
