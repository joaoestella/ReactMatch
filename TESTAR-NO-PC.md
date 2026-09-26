# Testar o SyncVideo no seu computador

Pasta principal do projeto: `C:\Users\j0hnn\OneDrive\Desktop\SyncVideo`.

As próximas alterações devem ser feitas nessa pasta. A pasta `extension` contém a extensão que o Chrome carrega. Os arquivos em `outputs` da conversa são cópias para entrega.

## Instalar uma vez

1. Abra o **Google Chrome normal**, fora do navegador interno do Codex.
2. Digite `chrome://extensions` na barra de endereços.
3. Ative **Modo do desenvolvedor**.
4. Clique em **Carregar sem compactação**.
5. Selecione `C:\Users\j0hnn\OneDrive\Desktop\SyncVideo\extension`.
6. Abra o menu de extensões, no ícone de quebra-cabeça do Chrome, e clique em **SyncVideo**. Fixe o ícone se quiser.

Não é necessário instalar Node.js ou executar comandos para usar a extensão.

## Primeiro teste: conhecer a interface

No painel do SyncVideo, clique em **Experimentar demonstração**, depois **Aplicar tempos informados** e **Iniciar acompanhamento**. Use **Simular atraso de 6s** para observar a correção. Essa demonstração usa relógios simulados; não controla vídeos reais.

## Segundo teste: dois vídeos no Chrome

1. Saia da demonstração.
2. Abra dois vídeos em abas do mesmo Chrome e dê play uma vez em cada um. Para começar, use duas cópias do mesmo vídeo em um player HTML5 acessível.
3. No painel, clique em **Atualizar abas** e conecte uma aba no lado A e outra no B. Aceite o acesso apenas aos sites escolhidos.
4. Selecione **Mesmo momento**, clique em **Pausar os dois** e ajuste os vídeos para a mesma cena.
5. Clique em **Marcar mesmo momento** e em **Iniciar acompanhamento**.
6. Mude a posição do vídeo B alguns segundos para testar a recuperação. Pause A para testar se B acompanha.

A é a referência; B é o vídeo que recebe os ajustes. A posição exibida pelos players não precisa ser igual quando os conteúdos forem diferentes. É necessário marcar cenas ou momentos correspondentes.

## Testar a leitura de um cronômetro

Use vídeos com relógios legíveis que representem o mesmo conteúdo. Escolha **Relógios na imagem** e clique em **Selecionar relógio** de cada lado. Selecione a mesma aba conectada, marque o retângulo dos números e confirme.

Para conferir uma leitura, pause os dois e clique em **Ler relógios agora**. Para leitura contínua, configure as duas capturas e inicie o acompanhamento. A versão atual lê os números automaticamente, mas você ainda indica a região do relógio.

## Depois de uma alteração no projeto

1. Pare o acompanhamento e feche o painel do SyncVideo.
2. Volte a `chrome://extensions` e clique no ícone **Recarregar** do SyncVideo.
3. Atualize as abas dos vídeos para remover a versão antiga do código que acessa os players.
4. Abra o SyncVideo novamente e reconecte as duas abas.

Não precisa instalar a extensão de novo. O Chrome usa diretamente os arquivos da pasta `extension`.

## Se algo não funcionar

- **Nenhum vídeo encontrado:** dê play na página e tente conectar novamente. Players dentro de iframes e componentes fechados ainda não são suportados.
- **Trecho indisponível:** o player pode não permitir voltar ou avançar até o ponto necessário.
- **Captura preta ou relógio ilegível:** a plataforma pode restringir a captura ou a região escolhida pode estar pequena demais.
- **Mudou de episódio, vídeo ou anúncio:** marque uma nova referência quando o conteúdo correto voltar.

O endereço `http://127.0.0.1:4188/` é uma prévia local da interface. Para controlar abas reais, abra a extensão pelo ícone do Chrome. Plataformas comerciais ainda precisam de testes específicos de compatibilidade.
