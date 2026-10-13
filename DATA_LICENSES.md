# Данные и лицензии

## Данные

Все временные ряды, состояния двойников и события на стенде синтетические: их порождает модель шахты (`team/minecore/`). Датасеты не скачиваются и в репозитории не хранятся. Персональных данных и конфиденциальных сведений организаций нет; бригады обезличены (`crew-01…08`).

Из открытых источников взяты только отдельные числовые параметры (глубины, мощность, характеристики техники, нормы, результаты испытаний) со ссылкой на источник. Тексты, изображения и таблицы источников в репозиторий не копировались.

| Источник | Что взято | Условия использования |
|---|---|---|
| [АО «ТНК «Казхром», Донской ГОК](https://www.kazchrome.com/ru/business-overview/divisions/donskoy/), [ERG: открытие шахты «Болашак»](https://www.erg.kz/ru/news/show/3493), [ERG: возобновление работ](https://www.erg.kz/ru/news/show/3659) | Месторождения, число и глубина горизонтов, проектная мощность | Открытые пресс-публикации; используются факты со ссылкой |
| [«Недра», 2022](https://www.vnedra.ru/2022/05/23/globalnye-perspektivy-dgok/), [dprom.kz](https://dprom.kz/novosti/donskoj-gok-perehodit-na-samohodnuyu-gornuyu-tehniku/), [AGMP News](https://agmpnews.kz/umnaya-shahta-pervye-samohodnye-mashiny-rabotayut-pod-zemlej/) | Горизонт −480 м на глубине 900 м; состав самоходной техники | Открытые публикации СМИ; факты со ссылкой |
| Epiroc: паспорта [Scooptram ST14 SG](https://www.epiroc.com/content/dam/epiroc/underground-mining-and-tunneling/lhd/electric-scooptram/scooptram-st14-sg/technical-specification/9869%200237%2001b%20Scooptram%2014%20SG%20Technical%20Specification_digital.pdf) и [Minetruck MT42 SG](https://www.epiroc.com/content/dam/epiroc/underground-mining-and-tunneling/lhd/minetruck/minetruck-mt42-sg/9869%200290%2001b_Minetruck%20MT42%20SG%20technical%20specification_digital.pdf) | Грузоподъёмность, ёмкость батарей | Общедоступная техническая документация производителя; используются характеристики со ссылкой. Названия моделей — товарные знаки Epiroc |
| [Приказ МИР РК от 30.12.2014 № 352](https://adilet.zan.kz/rus/docs/V1400010247) | ПДК CO, требования к реверсу ГВУ, самоспасатели, действия при загазовании | Нормативный правовой акт РК, официальный текст в ИПС «Әділет» |
| R. Hansen, H. Ingason, «Heat release rate measurements of burning mining vehicles in an underground mine», Fire Safety Journal 61 (2013); [запись](https://www.diva-portal.org/smash/record.jsf?pid=diva2%3A647975), [отчёт](https://www.ctif.org/sites/default/files/library/files/fulltext01.pdf) | Пиковые мощности и время развития пожаров горной техники | Научная публикация; используются результаты со ссылкой |
| SFPE Handbook of Fire Protection Engineering (D. A. Purser; T. Jin) | Модель дозы CO (FED), скорость движения в дыму, коэффициент экстинкции сажи | Справочник; используются формулы и константы со ссылкой |
| M. J. McPherson, «Subsurface Ventilation and Environmental Engineering» | Коэффициенты аэродинамического сопротивления выработок | Учебник; используются табличные значения со ссылкой |

## Программные компоненты

Код команды распространяется по лицензии MIT ([LICENSE](LICENSE)). Сторонние компоненты, которые собираются в образы решения:

| Компонент | Версия | Лицензия |
|---|---|---|
| React, React DOM | 18.3.1 | MIT |
| three.js | 0.170.0 | MIT |
| lucide-react (иконки) | 0.460.0 | ISC |
| IBM Plex Sans, IBM Plex Mono (@fontsource) | 5.3.0 | SIL Open Font License 1.1 |
| Vite, @vitejs/plugin-react (сборка) | 5.4, 4.7 | MIT |
| TypeScript (сборка) | 5.6 | Apache-2.0 |
| paho-mqtt (Python) | 2.1.0 | EPL-2.0 / EDL-1.0 |
| Образ python:3.12-slim | 3.12 | PSF License, Debian (разные свободные лицензии) |
| Образы node:22-alpine, nginx:1.25-alpine | 22, 1.25 | MIT (Node.js), BSD-2-Clause (nginx), Alpine (разные свободные лицензии) |

Платформа OpenEgiz v1.0.4 и её компоненты (Eclipse Ditto, Mosquitto, Telegraf, InfluxDB, Grafana и др.) входят в шаблон конкурса и распространяются по своим лицензиям, см. [OPENEGIZ.md](OPENEGIZ.md).
