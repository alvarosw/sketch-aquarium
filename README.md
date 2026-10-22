# Sketch Aquarium

Aquário de desenhos: pinte um animal no papel, fotografe e veja ele nadar numa tela.

## O que é

O projeto tem duas interfaces que funcionam juntas:

- **Aquário** (`/aquarium`): cena subaquática em tela cheia para PC ou projetor. Mostra as criaturas desenhadas nadando e atualiza ao vivo quando alguém envia um novo desenho.
- **Captura** (`/capture`): página para celular ou tablet. Lê a foto da folha, recorta o desenho e envia para o aquário. Também lista as criaturas e permite apagar.

São 7 criaturas, cada uma com seu molde:

| Código | Espécie        | Movimento                                   |
|--------|----------------|---------------------------------------------|
| 1      | Peixe          | Cauda ondulando                             |
| 2      | Tubarão        | Cauda ondulando, mais lento                 |
| 3      | Lula           | Propulsão em jatos                          |
| 4      | Tartaruga      | Nadada com as nadadeiras                    |
| 5      | Água-viva      | Pulsa o sino e balança os tentáculos        |
| 6      | Arraia         | Bate as asas e desliza                      |
| 7      | Cavalo-marinho | Flutua em pé, balançando a cauda            |

O molde traz só a silhueta tracejada do animal e círculos tracejados marcando onde ficam os olhos. A pessoa desenha os olhos do jeito que quiser e pinta o resto; no aquário, os olhos piscam de tempos em tempos.

## Requisitos

- Node.js 18 ou superior.
- Nenhuma dependência externa: o servidor usa apenas módulos nativos do Node (`node:*`).

## Como rodar

```bash
npm start
```

Por padrão o servidor escuta na porta 8000. Para usar outra porta:

```bash
PORT=3000 npm start
```

Ao iniciar, o terminal mostra os endereços. Abra `http://localhost:8000/` no próprio computador, ou um dos endereços de rede (LAN) impressos, por exemplo `http://192.168.0.10:8000/capture` no celular.

O celular e o computador precisam estar na mesma rede Wi-Fi.

## Passo a passo de uso

1. Abra `/templates` e imprima os moldes em A4 paisagem.
2. Desenhe os olhos nos círculos tracejados e pinte o animal dentro do contorno. Não cubra os 4 quadrados pretos dos cantos nem as 3 células do código, embaixo à direita.
3. No computador ou projetor, abra `/aquarium` e clique na tela para entrar em tela cheia.
4. No celular ou tablet, abra `/capture`.
5. Fotografe a folha inteira, com os 4 quadrados pretos visíveis.
6. Confira a prévia do recorte. Se estiver ruim, toque em "Fotografar de novo".
7. Toque em "Enviar para o aquário". O desenho aparece nadando na tela.
8. Para apagar um desenho, use a lista na página `/capture` e toque no ícone de lixeira.

## Dicas para uma boa foto

- Use luz uniforme, sem reflexos fortes.
- Deixe a folha plana, sem dobras nem curvatura.
- Evite sombras fortes sobre a folha, inclusive a da própria pessoa ou do celular.
- Enquadre a folha toda, com os 4 quadrados pretos dentro da foto.

## Como funciona

1. A página `/capture` localiza os 4 quadrados pretos (marcadores) nos cantos da folha e lê as 3 células de código, que identificam a espécie.
2. Com os marcadores, calcula uma homografia que corrige a perspectiva e endireita a folha.
3. Recorta a área do desenho e mantém apenas o interior do contorno da espécie, deixando o fundo transparente.
4. Envia o recorte como PNG para o servidor (`POST /api/fish`).
5. O servidor salva o PNG em `data/fish/` e a lista em `data/fish.json`. Ele mantém no máximo 60 criaturas; ao passar do limite, remove a mais antiga.
6. No aquário, a piscada é uma pálpebra na cor média ao redor de cada olho, que desce e sobe sobre o olho desenhado.
7. Cada mudança é enviada ao aquário e a `/capture` por Server-Sent Events (`/api/events`), então a tela atualiza sem recarregar.

Os dados ficam na pasta `data/`, ignorada pelo Git.

## API

| Método | Caminho           | Descrição                                                                 |
|--------|-------------------|---------------------------------------------------------------------------|
| GET    | `/`               | Página inicial com os links                                               |
| GET    | `/capture`        | Página de captura (celular/tablet)                                        |
| GET    | `/aquarium`       | Aquário (PC/projetor)                                                     |
| GET    | `/templates`      | Moldes para imprimir                                                      |
| GET    | `/api/fish`       | Lista as criaturas (JSON)                                                 |
| POST   | `/api/fish`       | Envia um desenho: `{"species": "fish", "image": "data:image/png;base64,..."}`. Responde `201` com o registro |
| DELETE | `/api/fish/:id`   | Apaga uma criatura. Responde `204`, ou `404` se não existir               |
| GET    | `/fish/:id.png`   | Imagem PNG de uma criatura                                                |
| GET    | `/api/events`     | Stream SSE com os eventos `init`, `add` e `remove`                        |

Limites: corpo de até 5 MB e imagem PNG de até 3 MB. Erros de API voltam como `{"error": "..."}`.

## Testes

```bash
npm test
```

Executa os testes do Node (`node --test`) em `test/`: testes do servidor e da detecção de folha.

## Como adicionar uma nova espécie

1. Edite `public/shared/species.js`.
2. Crie os contornos em coordenadas do quadro da criatura (240 × 150 mm), voltada para a direita, usando os auxiliares já existentes no arquivo (`buildParts`, `ellipse`, `tube`, `sample`, `flipY`).
3. Adicione um objeto ao array `SPECIES` com os campos:
   - `id`: identificador único (texto, sem espaços).
   - `name`: nome exibido em português.
   - `code`: valor usado no código de 3 células. Os valores 1 a 7 já estão em uso; para mais espécies é preciso aumentar o número de células em `CODE`.
   - `parts` e `outline`: contornos gerados pelos auxiliares (a silhueta é a união das partes).
   - `eyes`: lista de `[x, y, raio]` dos olhos, em mm (pode ser vazia).
   - `motion`: `type` (`tail`, `jet`, `paddle`, `drift`, `flap` ou `hover`), `speed`, `size` e `depth`.
4. Reinicie o servidor e confira a página `/templates`, que gera os moldes a partir de `SPECIES`.

Também é preciso ajustar o estilo de ondulação em `TUNING` de `public/aquarium.js`, se a nova espécie precisar de um movimento diferente.

## Licença

MIT. Veja o arquivo [LICENSE](LICENSE).
