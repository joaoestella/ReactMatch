# SyncVideo — prévia 0.1

Uma extensão para acompanhar dois vídeos no mesmo momento. Feita para reacts, séries, filmes, lives, esportes e aulas. O produto não depende de um esporte ou de uma comunidade específica.

Esta é uma primeira versão local e instalável, não um produto publicado na loja. Não exige conta, assinatura ou servidor.

## Instalar no Chrome

1. Extraia o arquivo ZIP, se estiver usando o pacote compactado.
2. Abra `chrome://extensions` no Chrome.
3. Ative **Modo do desenvolvedor** no canto superior direito.
4. Clique em **Carregar sem compactação**.
5. Selecione a pasta **extension** deste projeto — a que contém `manifest.json`.
6. No menu de extensões do Chrome, abra **SyncVideo — assista no mesmo momento**. Você pode fixar seu ícone.

Não é necessário instalar ferramentas de programação. Todos os arquivos do reconhecimento de texto já estão incluídos.

## Primeiro teste: demonstração

Clique em **Experimentar demonstração**. Os dois relógios são simulados e começam com 14 segundos de diferença. Nenhum vídeo real é controlado nessa demonstração.

1. Clique em **Aplicar tempos informados**.
2. Clique em **Iniciar acompanhamento**.
3. Use **Simular atraso de 6s** e observe a recuperação.
4. Experimente os ajustes de meio segundo.
5. Clique em **Sair da demonstração** para conectar vídeos reais.

## Conectar vídeos reais

Abra os vídeos em abas do mesmo navegador. Dê play uma vez em cada página para o player carregar. No painel, atualize a lista, selecione cada aba e clique em **Conectar**. O Chrome pedirá acesso ao site selecionado.

- **A — Vídeo de referência:** orienta a sincronização.
- **B — Vídeo que acompanha:** recebe ajustes de posição. No modo de mesmo momento, também acompanha as pausas de A.

Você decide qual conteúdo ocupa cada lado. Uma live do criador pode ser A e o filme B; o jogo pode ser A e a reação B. Escolha como B um player que permita voltar ou avançar nos trechos necessários. A extensão não consegue acessar imagens que ainda não chegaram.

### Mesmo momento

Indicado quando você consegue identificar a mesma cena ou o ponto informado pelo criador.

1. Clique em **Pausar os dois**.
2. Nas páginas dos vídeos, posicione cada um no ponto correspondente. Eles podem ter tempos de reprodução diferentes.
3. Volte ao painel e clique em **Marcar mesmo momento**.
4. Inicie o acompanhamento. Os dois vídeos serão reproduzidos.

O SyncVideo mantém a relação definida entre as posições dos players. Não identifica automaticamente cenas equivalentes. Se um react tiver cortes ou pausas do filme dentro da gravação, será necessário marcar uma nova referência. Se o criador mostrar um cronômetro confiável, o modo de relógios pode ser mais adequado.

### Relógios na imagem: manual

Os dois relógios devem representar o mesmo conteúdo e a mesma etapa. Não compare o tempo total de uma live com o minuto do jogo, nem relógios de episódios diferentes.

1. Selecione **Relógios na imagem** e pause os dois vídeos.
2. Informe os tempos visíveis: `25:40`, `125:40` ou `01:25:40`.
3. Escolha contagem crescente ou regressiva.
4. Clique em **Aplicar tempos informados** e depois inicie o acompanhamento.

Sem capturas ativas, o acompanhamento utiliza a relação calibrada entre os players. Ele não está lendo a imagem continuamente.

### Relógios na imagem: leitura local experimental

1. Em cada lado, clique em **Selecionar relógio**.
2. No seletor do Chrome, escolha **a mesma aba conectada naquele lado**, não a tela inteira.
3. Arraste sobre os números do cronômetro e confirme a região. Não inclua placares, legendas ou outros relógios.
4. Com os dois vídeos pausados, **Ler relógios agora** preenche os campos para você conferir e aplicar.
5. Com as duas capturas configuradas, **Iniciar acompanhamento** ativa a leitura contínua. O reconhecimento usa arquivos locais e não envia as imagens para um servidor.

A leitura contínua aguarda três observações consistentes antes de ajustar. Relógios ilegíveis, parados ou incoerentes suspendem os ajustes. Correções automáticas acima de 30 segundos exigem conferir e aplicar os tempos manualmente. Um cronômetro incorreto dentro da live continuará sendo uma referência incorreta.

**Parar acompanhamento** interrompe os ajustes, mas mantém as capturas autorizadas para você poder reiniciar. **Encerrar capturas** encerra a leitura das imagens. Fechar o painel também encerra tudo.

## Limites desta versão

- Mantenha o painel aberto e visível. Minimizar ou ocultar janelas pode reduzir a frequência de atualização pelo navegador.
- Suporte inicial a vídeos HTML5 acessíveis na página principal, inclusive em componentes com shadow DOM aberto. Iframes e componentes fechados ainda não são suportados.
- A janela navegável da transmissão limita os ajustes. Não há como garantir sincronização se o player não disponibilizar o trecho desejado.
- O ajuste fino é aplicado durante o acompanhamento e limitado a ±30 segundos.
- As duas reproduções devem estar na mesma velocidade.
- Mudanças detectáveis no endereço do vídeo invalidam a referência. Anúncios são detectados apenas quando o player usa um sinal conhecido; outros anúncios ou trocas de conteúdo podem exigir intervenção manual.
- O OCR lê números em `mm:ss` ou `hh:mm:ss`. Notações como `45:00 + 02:15`, identificação automática de etapa e procura automática do relógio ainda não estão implementadas.
- DRM e restrições das plataformas podem impedir captura ou controle. Não há compatibilidade homologada com Netflix, Prime Video, Disney+, Twitch ou YouTube nesta entrega.
- Não controla TVs nem outros aplicativos. Não compartilha ou retransmite filmes, séries ou partidas.
- Ao parar ou fechar, os vídeos permanecem na posição e no estado de reprodução resultantes dos últimos ajustes.

## Privacidade e permissões

O acesso à lista de abas permite escolher os vídeos. A permissão de acesso ao conteúdo de cada site é solicitada apenas ao conectar. Ela permite ler e controlar o player daquele site e pode ser removida nas configurações da extensão do Chrome.

Capturas exigem uma escolha explícita no seletor do navegador. Elas são processadas em memória no próprio dispositivo. Não há analytics, login, upload de imagens ou armazenamento de histórico. O mecanismo de OCR pode manter seus modelos públicos no armazenamento local do navegador para acelerar a inicialização.

## Validação desta entrega

- Testes automatizados de relógios, contagem regressiva, leituras incoerentes, intervalos disponíveis, anúncios, diferenças de velocidade e limites de correção.
- Extensão carregada em um perfil isolado de Chromium; demonstração, ajuste fino e encerramento verificados.
- OCR empacotado executado sob a política de segurança real da extensão: reconheceu `25:40` em uma imagem sintética, com confiança reportada de 96/100. Isso não mede a precisão em lives reais.
- Duas abas com vídeos HTML5 locais: calibração de 15 segundos, recuperação de um desvio introduzido de 6 segundos, acompanhamento de pausa/reprodução e interrupção após troca de fonte. O acesso a localhost foi pré-autorizado em uma cópia exclusiva de teste; o seletor de permissão por site ainda precisa de validação interativa.
- Capturas reais de duas abas locais via `getDisplayMedia`: seleção de região, leitura de `15:20` e `15:25`, calibração e recuperação automática de um novo desvio pela leitura contínua. O navegador de teste selecionou as abas automaticamente; esse teste não substitui a validação do seletor interativo com usuários.
- Layout estreito sem rolagem horizontal e página sem erros de JavaScript nos testes executados.

O seletor interativo do usuário e o OCR contínuo em plataformas externas ainda precisam de teste com conteúdos reais. Relógios em baixa resolução, layouts diferentes e proteções de serviços externos não foram homologados.

## Desenvolvimento

Os fontes estão em `extension/`. Para executar os testes puros, instale Node.js e rode `npm test` nesta pasta. A extensão pronta não precisa de npm.

Para repetir os testes de navegador, execute `npm install`, `npx playwright install chromium` e `npm run test:browser`. Esses testes usam perfis temporários, vídeos gerados localmente e uma cópia de teste da extensão com acesso pré-autorizado apenas a localhost. Não usam seu perfil pessoal.

Para reconstruir os arquivos locais de OCR após instalar as dependências, execute `npm run bundle:ocr`. Para abrir a interface de demonstração fora da extensão, execute `npm run preview` e visite o endereço local indicado. O controle de abas reais só funciona na extensão instalada.

Arquitetura: `panel.js` coordena a sessão; `browser-adapter.js` conecta as abas; `media-bridge.js` acessa os players; `core.js` valida os tempos e decide ajustes; `ocr.js` captura regiões e executa Tesseract localmente; `demo-adapter.js` simula os relógios apenas no modo de demonstração.

Dependências de OCR incluídas: Tesseract.js 7.0.0, Tesseract.js Core e dados `eng`. As versões e licenças estão em `extension/vendor/`. Nenhum código externo é baixado durante o uso.

Veja **PROXIMOS-PASSOS.md** para a evolução do produto e o que ainda não faz parte desta prévia.
