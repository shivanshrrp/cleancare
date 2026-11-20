# AI evaluation: voice check

Measured 20 Nov 2026, 23:36 IST against the live server function (version 2.2.2, answering via Vertex AI, model gemini-3.1-flash-lite). Re-run with `python3 tools/eval-voice.py`.

| Result | Value |
| --- | --- |
| Correct bag colour | **20 of 20** (100%) |
| Median reply time | 1.6 s |
| 90th percentile | 2.9 s |
| Languages | English, Hindi, Tamil |

**Method.** Each item is spoken by a built-in macOS Indian voice (Lekha for Hindi, Rishi and Tara for Indian
English, Vani for Tamil), converted to the 16 kHz mono WAV the app records, and sent to the deployed function
exactly as the app sends it. The expected colour follows Schedule I of the Bio-Medical Waste Management Rules,
2016. Reply time is measured from the client and includes the network. Synthetic voices are clearer than a busy
clinic, so treat this as a baseline; staff always confirm the colour before a bag is saved.

| # | Language | Said | Expected | AI answer | Confidence | Heard | Time |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Hindi | इस्तेमाल की हुई सुई | White | White | 1.00 | इस्तेमाल की हुई सुई | 2.7 s |
| 2 | Hindi | सर्जिकल ब्लेड | White | White | 1.00 | surgical blade | 1.4 s |
| 3 | Hindi | सुई लगी हुई इस्तेमाल की गई सिरिंज | White | White | 1.00 | सुई लगी हुई इस्तेमाल की गई सिरिंज | 1.7 s |
| 4 | Hindi | खून से सना हुआ रुई का फाहा | Yellow | Yellow | 1.00 | कौन सा सना हुआ रुई का थाहा | 5.0 s |
| 5 | Hindi | घाव की गंदी पट्टी | Yellow | Yellow | 0.95 | घाव की गंदी पट्टी | 1.4 s |
| 6 | Hindi | इस्तेमाल किए हुए दस्ताने | Red | Red | 1.00 | इस्तेमाल किए हुए दस्ताने | 1.3 s |
| 7 | Hindi | यूरिन बैग | Red | Red | 1.00 | Urine bag | 5.3 s |
| 8 | Hindi | टूटी हुई कांच की शीशी | Blue | Blue | 0.90 | टूटी हुई कांच की शीशी | 2.1 s |
| 9 | Hindi | एक्सपायर हो चुकी दवा की गोलियाँ | Yellow | Yellow | 1.00 | एक्सपायर्ड हो चुकी दवा की गोलियां | 1.7 s |
| 10 | Hindi | पुराना अखबार | None | None | 1.00 | पुराना अखबार | 1.1 s |
| 11 | English | a used lancet from a finger prick test | White | White | 1.00 | I used lancet from a finger prick test. | 2.9 s |
| 12 | English | an IV drip set with tubing | Red | Red | 1.00 | An IV drip set with tubing. | 1.6 s |
| 13 | English | a urinary catheter | Red | Red | 1.00 | a urinary catheter | 1.6 s |
| 14 | English | an empty glass ampoule | Blue | Blue | 1.00 | an empty glass ampoule | 2.1 s |
| 15 | English | gauze soaked in blood | Yellow | Yellow | 1.00 | gauze soaked in blood | 1.4 s |
| 16 | English | a plastic syringe without the needle | Red | Red | 1.00 | A plastic syringe without the needle. | 1.5 s |
| 17 | English | an empty cardboard box | None | None | 1.00 | An empty cardboard box. | 1.6 s |
| 18 | English | a broken glass slide from the lab | Blue | Blue | 1.00 | a broken glass slide from the lab | 1.5 s |
| 19 | Tamil | பயன்படுத்திய ஊசி | White | White | 1.00 | பயன்படுத்திய ஊசி | 1.9 s |
| 20 | Tamil | இரத்தம் படிந்த பஞ்சு | Yellow | Yellow | 1.00 | இரத்தம் படிந்த பஞ்சு | 1.9 s |

## History

| Run | Function | Correct | Median | What changed |
| --- | --- | --- | --- | --- |
| 1 | 2.2.1 | 18 of 20 | 1.7 s | First run |
| 2 | 2.2.2 | **20 of 20** | 1.6 s | Shared rules now spell out the common mix-ups |

Run 1 missed two Hindi items. Both were heard word for word, so the speech side worked; the colour was wrong:
"सुई लगी हुई इस्तेमाल की गई सिरिंज" (used syringe with needle attached) came back Red instead of White, and
"इस्तेमाल किए हुए दस्ताने" (used gloves) came back Yellow instead of Red, each at 0.90 confidence. The syringe hint
existed only in the photo prompt. Version 2.2.2 moved the commonly confused cases (syringe with needle, gloves, empty
vials) into the rules block that the photo and voice checks share. These two items are in this test set, so part of
the gain comes from fixing exactly them; a fresh set of items is the fair next test.
