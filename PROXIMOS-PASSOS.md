# Próximos passos do SyncVideo

## Direção do produto

Sincronização entre um conteúdo e uma reação, comentário, aula ou transmissão complementar. O público inicial deve ser escolhido para testar distribuição e compatibilidade; a arquitetura e a linguagem do produto permanecem gerais.

## Já implementado na prévia 0.1

- Seleção de dois vídeos com permissão por site.
- Referência manual entre momentos diferentes dos players.
- Correção recorrente de desvios e acompanhamento de pausa/reprodução no modo de referência.
- Tempos manuais em minutos/segundos ou horas/minutos/segundos.
- Leitura local de regiões escolhidas, com contagem crescente ou regressiva.
- Rejeição de leituras inconsistentes, tolerância e intervalo entre correções.
- Ajuste fino, demonstração e mensagens sobre trechos indisponíveis.

## Etapa 1 — validar compatibilidade e confiabilidade

Escolher uma combinação de plataforma de reação e player do conteúdo. Testar conteúdos autorizados de mais de um tipo: uma aula, um react gravado e um evento ao vivo. Registrar falhas de instalação, captura, controle, intervalos de navegação e funcionamento com janelas ocultas.

Testar o seletor real de abas e o OCR contínuo em diferentes resoluções, fontes de cronômetro, escalas do Windows e velocidades de reprodução. Tratar anúncios e troca de episódio com adaptadores específicos. Adicionar suporte a iframes somente com permissões delimitadas.

Critérios propostos: configurar em menos de um minuto após instalar, poucos ajustes manuais durante uma sessão e ausência de saltos incorretos nas situações testadas. A meta de até aproximadamente um segundo depende da resolução dos relógios e do player; não é uma garantia atual.

## Etapa 2 — reduzir o trabalho de configuração

Localização automática de regiões prováveis de cronômetro, mantendo seleção manual como alternativa. Perfis locais de layout, invalidados quando resolução ou posição mudarem. Reconhecimento de etapas e formatos adicionais de relógio, sem associar um mesmo número a episódios ou períodos distintos.

Para vídeos sem relógio, estudar marcos de sincronização e múltiplos pontos por trecho. Um deslocamento fixo não resolve sozinho reacts editados, pausas no conteúdo ou versões diferentes de um filme.

## Etapa 3 — ferramentas para criadores

Link que prepara a sessão e sugere configurações. Marcador visual opcional dentro da transmissão, associado ao momento efetivamente acompanhado pelo criador. O marcador chega junto com a reação; dados enviados por servidor precisam ser relacionados à posição recebida do vídeo, pois podem chegar antes da transmissão.

O atraso deve continuar individual por espectador. Um único atraso definido pelo criador não serve automaticamente para toda a audiência.

## Etapa 4 — distribuição e negócio

Teste com um pequeno grupo de criadores de conteúdos diferentes. Comparação real com concorrentes: tempo até sincronizar, intervenções por sessão, plataformas suportadas e uso na sessão seguinte. Definir cobrança depois de observar recorrência e benefício concreto.

Preparar publicação na loja somente após validar permissões, experiência de instalação, política de privacidade e compatibilidade anunciada. A prévia atual não está publicada.
